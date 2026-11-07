"""Loopback-only SSH fixture for Tabby's Electron integration checks.

Uses Paramiko (a development-only Python dependency); never authenticates to an
external host. Usernames: normal, stall-auth. It records connection/channel counts
through a second loopback HTTP port for cancellation/resource assertions.
Commands sent to its interactive shell: flood <bytes>, early flood, ping, exit.
"""
import json
import socket
import select
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
import paramiko

stats = {"connections": 0, "channels": 0, "sent": 0, "auth_waiting": 0}
lock = threading.Lock()
key = paramiko.RSAKey.generate(2048)

def record(name, delta):
    with lock:
        stats[name] += delta

class Handler(paramiko.ServerInterface):
    def __init__(self, transport):
        self.transport = transport
        self.shells = {}
    def get_allowed_auths(self, username):
        return 'none,password'
    def check_auth_none(self, username):
        if username == 'stall-auth':
            record('auth_waiting', 1)
            while self.transport.is_active():
                if select.select([self.transport.sock], [], [], .05)[0]:
                    if not self.transport.sock.recv(32768):
                        self.transport.close()
                        break
            record('auth_waiting', -1)
            return paramiko.AUTH_FAILED
        return paramiko.AUTH_SUCCESSFUL
    def check_channel_request(self, kind, channel_id):
        return paramiko.OPEN_SUCCEEDED if kind == 'session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
    def check_channel_pty_request(self, channel, *args):
        return True
    def check_channel_window_change_request(self, channel, *args):
        return True
    def check_channel_shell_request(self, channel):
        self.shells.setdefault(channel.get_id(), threading.Event()).set()
        return True

def send(channel, data, stderr=False):
    if stderr:
        channel.sendall_stderr(data)
    else:
        channel.sendall(data)
    record('sent', len(data))

def shell(channel, ready):
    record('channels', 1)
    try:
        if not ready.wait(10):
            return
        send(channel, b'FIXTURE READY\r\n')
        pending = b''
        while not channel.closed:
            data = channel.recv(4096)
            if not data:
                break
            pending += data.replace(b'\r', b'\n')
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                command = line.decode().strip()
                if command.startswith('flood '):
                    length = int(command.split()[1])
                    # ASCII plus split UTF-8 and an OSC sequence exercise middleware.
                    chunk = (b'0123456789abcdef' * 1023) + b'0123456789abcd\r\n'
                    assert len(chunk) == 16384
                    for i in range(length // len(chunk)):
                        send(channel, chunk, i % 7 == 0)
                    send(channel, b'\r\nFLOOD DONE\r\n')
                elif command == 'ping':
                    send(channel, b'PONG\r\n')
                elif command == 'unicode':
                    for byte in '日本語\r\n'.encode():
                        send(channel, bytes([byte]))
                    send(channel, b'\x1b]0;fixture title\x07UNICODE DONE\r\n')
                elif command == 'exit':
                    send(channel, b'FINAL OUTPUT\r\n')
                    channel.shutdown_write()
                    return
    except (OSError, EOFError):
        pass
    finally:
        try:
            channel.close()
        except (OSError, EOFError):
            pass
        finally:
            record('channels', -1)

def client(sock):
    record('connections', 1)
    transport = paramiko.Transport(sock)
    handler = Handler(transport)
    try:
        transport.add_server_key(key)
        transport.start_server(server=handler)
        while transport.is_active():
            channel = transport.accept(.1)
            if channel is not None:
                ready = handler.shells.setdefault(channel.get_id(), threading.Event())
                threading.Thread(target=shell, args=(channel, ready), daemon=True).start()
    except (OSError, EOFError, paramiko.SSHException):
        pass
    finally:
        transport.close()
        record('connections', -1)

class Metrics(BaseHTTPRequestHandler):
    def do_GET(self):
        with lock:
            body = json.dumps(stats).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *_):
        pass

listener = socket.create_server(('127.0.0.1', 0))
metrics = HTTPServer(('127.0.0.1', 0), Metrics)
threading.Thread(target=metrics.serve_forever, daemon=True).start()
print(json.dumps({'ssh': listener.getsockname()[1], 'metrics': metrics.server_port}), flush=True)
while True:
    sock, _ = listener.accept()
    threading.Thread(target=client, args=(sock,), daemon=True).start()

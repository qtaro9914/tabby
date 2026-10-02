import assert from 'node:assert/strict'
import test from 'node:test'
import { FileTransfer } from '../src/api/platform.ts'

class TestTransfer extends FileTransfer {
    closed = false

    getName (): string { return 'test' }
    getSize (): number { return 0 }
    close (): void { this.closed = true }
}

test('preserves cancellation when completion arrives later', () => {
    const transfer = new TestTransfer()
    transfer.cancel()
    transfer.setCompleted(true)
    assert.equal(transfer.getState(), 'cancelled')
    assert.equal(transfer.isComplete(), false)
    assert.equal(transfer.closed, true)
})

test('preserves failure and its error when completion arrives later', () => {
    const transfer = new TestTransfer()
    transfer.fail(new Error('write failed'))
    transfer.setCompleted(true)
    assert.equal(transfer.getState(), 'failed')
    assert.equal(transfer.getError(), 'write failed')
    assert.equal(transfer.isComplete(), false)
})

test('does not restart a cancelled or failed transfer', () => {
    for (const outcome of ['cancel', 'fail'] as const) {
        const transfer = new TestTransfer()
        if (outcome === 'cancel') {
            transfer.cancel()
        } else {
            transfer.fail('write failed')
        }
        const state = transfer.getState()
        transfer.setCompleted(false)
        assert.equal(transfer.getState(), state)
    }
})

test('zero-length transfers remain running until explicitly completed', () => {
    const transfer = new TestTransfer()
    assert.equal(transfer.getCompletedBytes(), transfer.getSize())
    assert.equal(transfer.isComplete(), false)
    assert.equal(transfer.isFinished(), false)
})

test('finalization remains pending until completion', async () => {
    const transfer = new TestTransfer()
    transfer.setFinalizing()
    await transfer.finalize()
    assert.equal(transfer.getState(), 'finalizing')
    assert.equal(transfer.isFinished(), false)
    assert.equal(transfer.isCancellable(), false)
    transfer.setCompleted(true)
    assert.equal(transfer.isComplete(), true)
    assert.equal(transfer.isFinished(), true)
})

test('cancellation during finalization leaves the transfer pending', () => {
    const transfer = new TestTransfer()
    transfer.setFinalizing()
    transfer.cancel()
    assert.equal(transfer.getState(), 'finalizing')
    assert.equal(transfer.closed, false)
})

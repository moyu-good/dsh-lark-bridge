import { describe, expect, it } from 'vitest'
import { fetchDeepseekBalance, formatBalanceReply } from '../src/balance.ts'

/** The exact payload shape the live endpoint returned (2026-09-09). */
function jsonResponse(body: unknown, status = 200): { status: number; json: () => Promise<unknown> } {
  return { status, json: async () => body }
}

describe('fetchDeepseekBalance', () => {
  it('parses the live payload shape (is_available + balance_infos)', async () => {
    let authHeader: string | undefined
    const result = await fetchDeepseekBalance('sk-test', async (url, init) => {
      expect(String(url)).toBe('https://api.deepseek.com/user/balance')
      authHeader = init?.headers?.Authorization
      return jsonResponse({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '1.66', granted_balance: '0.00', topped_up_balance: '1.66' },
          { currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
        ],
      })
    })
    expect(authHeader).toBe('Bearer sk-test')
    expect(result.available).toBe(true)
    expect(result.balances).toHaveLength(2)
    expect(result.balances[0]).toEqual({ currency: 'CNY', total: '1.66', granted: '0.00', toppedUp: '1.66' })
  })

  it('a non-200 surfaces as a throw naming the status', async () => {
    await expect(fetchDeepseekBalance('sk-bad', async () => jsonResponse({ error: 'x' }, 401)))
      .rejects.toThrow('401')
  })

  it('an empty balance_infos is a shape error, not a silent zero', async () => {
    await expect(fetchDeepseekBalance('sk-test', async () => jsonResponse({ is_available: true })))
      .rejects.toThrow('没有余额条目')
  })
})

describe('formatBalanceReply', () => {
  it('shows the breakdown only for non-zero granted buckets, plus phase and stamp', () => {
    const reply = formatBalanceReply({
      available: true,
      balances: [
        { currency: 'CNY', total: '1.66', granted: '1.00', toppedUp: '0.66' },
        { currency: 'USD', total: '0.00', granted: '0.00', toppedUp: '0.00' },
      ],
    }, new Date('2026-09-09T03:20:00Z')) // 11:20 Beijing, Wednesday → peak
    expect(reply).toContain('**DeepSeek 余额**')
    expect(reply).toContain('查询于北京时间')
    expect(reply).toContain('CNY：**1.66**（赠送 1.00 + 充值 0.66）')
    expect(reply).toContain('USD：**0.00**')
    expect(reply).not.toContain('（赠送 0.00')
    expect(reply).toContain('高峰（双倍计费）')
  })

  it('flags when the platform marks the key unavailable', () => {
    const reply = formatBalanceReply({
      available: false,
      balances: [{ currency: 'CNY', total: '9.90', granted: '0.00', toppedUp: '9.90' }],
    }, new Date('2026-09-09T14:00:00Z')) // 22:00 Beijing → off-peak
    expect(reply).toContain('⛔')
    expect(reply).toContain('空闲（半价）')
  })
})

import {
  invoiceDue,
  remainingDue,
  resolvePaymentApply,
  roundMoney,
  withPaymentProgress,
} from "../paymentMath";

describe("roundMoney", () => {
  it("rounds to cents", () => {
    expect(roundMoney(10.005)).toBe(10.01);
    expect(roundMoney(1.234)).toBe(1.23);
  });
});

describe("invoiceDue / remainingDue", () => {
  it("prefers totalAmount over amount", () => {
    expect(invoiceDue({ totalAmount: 50, amount: 40 })).toBe(50);
    expect(invoiceDue({ amount: 40 })).toBe(40);
  });

  it("never returns negative remaining", () => {
    expect(remainingDue(50, 60)).toBe(0);
    expect(remainingDue(50, 20)).toBe(30);
  });
});

describe("resolvePaymentApply", () => {
  it("defaults to the remaining balance", () => {
    expect(resolvePaymentApply(40, null)).toEqual({ apply: 40, partial: false, overpay: 0 });
    expect(resolvePaymentApply(40, undefined)).toEqual({ apply: 40, partial: false, overpay: 0 });
  });

  it("applies a smaller requested amount as a partial", () => {
    expect(resolvePaymentApply(40, 15)).toEqual({ apply: 15, partial: true, overpay: 0 });
  });

  it("records overpayment as overpay by default and rejects non-positive amounts", () => {
    // Overpayment is accepted by default: only the remaining balance is applied,
    // the excess is returned as `overpay`.
    expect(resolvePaymentApply(10, 10.02)).toEqual({ apply: 10, partial: false, overpay: 0.02 });
    // Callers may opt out to reject overpayment outright.
    expect(() => resolvePaymentApply(10, 10.02, { allowOverpay: false })).toThrow(/exceeds remaining due/);
    expect(() => resolvePaymentApply(10, 0)).toThrow(/greater than 0/);
    expect(() => resolvePaymentApply(10, -1)).toThrow(/greater than 0/);
  });
});

describe("withPaymentProgress", () => {
  it("adds amountPaid and remainingDue without changing billed amount", () => {
    const out = withPaymentProgress({ amount: 50, totalAmount: 50, amountPaid: 20 });
    expect(out.amount).toBe(50);
    expect(out.amountPaid).toBe(20);
    expect(out.remainingDue).toBe(30);
  });
});

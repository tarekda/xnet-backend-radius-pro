export function roundMoney(n: number): number {
  return Math.round(Number(n) * 100) / 100;
}

export function invoiceDue(invoice: { totalAmount?: number | null; amount?: number | null }): number {
  return roundMoney(Number(invoice.totalAmount ?? invoice.amount ?? 0));
}

export function remainingDue(due: number, paidSoFar: number): number {
  return roundMoney(Math.max(0, due - paidSoFar));
}

export function resolvePaymentApply(
  remaining: number,
  requested?: number | null,
  opts?: { allowOverpay?: boolean }
): { apply: number; partial: boolean; overpay: number } {
  const left = roundMoney(remaining);
  let overpay = 0;
  if (left < 0.01) {
    overpay = requested && Number.isFinite(Number(requested)) && Number(requested) > 0 ? roundMoney(Number(requested)) : 0;
    return { apply: 0, partial: false, overpay };
  }
  let apply = left;
  if (requested != null && Number.isFinite(Number(requested))) {
    const n = roundMoney(Number(requested));
    if (n <= 0) {
      throw Object.assign(new Error("Payment amount must be greater than 0"), { status: 400 });
    }
    if (n - left > 0.009) {
      if (opts?.allowOverpay ?? true) {
        apply = left;
        overpay = roundMoney(n - left);
      } else {
        throw Object.assign(
          new Error(`Payment ${n.toFixed(2)} exceeds remaining due ${left.toFixed(2)}`),
          { status: 400 }
        );
      }
    } else {
      apply = Math.min(n, left);
    }
  }
  apply = roundMoney(apply);
  return { apply, partial: apply + 1e-9 < left, overpay };
}

export function withPaymentProgress<T extends { totalAmount?: number | null; amount?: number | null; amountPaid?: number | null }>(
  invoice: T
): T & { amountPaid: number; remainingDue: number } {
  const due = invoiceDue(invoice);
  const paid = roundMoney(Number(invoice.amountPaid ?? 0));
  return {
    ...invoice,
    amountPaid: paid,
    remainingDue: remainingDue(due, paid),
  };
}

export const COMPANY_COLLECTION_METHODS = new Set(["cash", "pos", "transfer", "other", "gateway"]);

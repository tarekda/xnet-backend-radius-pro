import { Logger } from '../logging/logging';

const logger = Logger.getInstance();

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  successThreshold?: number;
  resetTimeoutMs?: number;
  timeoutMs?: number;
}

export interface CircuitBreakerMetrics {
  name: string;
  state: CircuitState;
  failures: number;
  consecutiveSuccesses: number;
  totalExecutions: number;
  totalFailures: number;
  totalRejections: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastStateChangeAt: string;
  nextAllowedAttemptAt: string | null;
}

export class CircuitBreakerOpenError extends Error {
  public readonly breakerName: string;
  public readonly resetInMs: number;

  constructor(breakerName: string, resetInMs: number) {
    super(`Circuit breaker '${breakerName}' is OPEN. Call rejected to prevent downstream overload.`);
    this.name = 'CircuitBreakerOpenError';
    this.breakerName = breakerName;
    this.resetInMs = resetInMs;
  }
}

export class CircuitBreaker {
  public readonly name: string;
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private consecutiveSuccesses = 0;
  private totalExecutions = 0;
  private totalFailures = 0;
  private totalRejections = 0;

  private lastFailureAt: Date | null = null;
  private lastSuccessAt: Date | null = null;
  private lastStateChangeAt: Date = new Date();
  private nextAllowedAttemptAt: Date | null = null;

  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly timeoutMs: number;

  constructor(name: string, options: CircuitBreakerOptions = {}) {
    this.name = name;
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 5);
    this.successThreshold = Math.max(1, options.successThreshold ?? 2);
    this.resetTimeoutMs = Math.max(1000, options.resetTimeoutMs ?? 30000);
    this.timeoutMs = Math.max(500, options.timeoutMs ?? 10000);
  }

  public getState(): CircuitState {
    this.evaluateState();
    return this.state;
  }

  private evaluateState(): void {
    if (this.state === CircuitState.OPEN && this.nextAllowedAttemptAt) {
      if (Date.now() >= this.nextAllowedAttemptAt.getTime()) {
        this.transitionTo(CircuitState.HALF_OPEN);
      }
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;
    this.lastStateChangeAt = new Date();

    if (newState === CircuitState.OPEN) {
      this.nextAllowedAttemptAt = new Date(Date.now() + this.resetTimeoutMs);
      logger.warn(
        `[CircuitBreaker:${this.name}] Transitioned ${oldState} -> OPEN. Next probe allowed in ${this.resetTimeoutMs}ms`
      );
    } else if (newState === CircuitState.HALF_OPEN) {
      this.consecutiveSuccesses = 0;
      this.nextAllowedAttemptAt = null;
      logger.info(`[CircuitBreaker:${this.name}] Transitioned ${oldState} -> HALF_OPEN (Canary mode active)`);
    } else if (newState === CircuitState.CLOSED) {
      this.failures = 0;
      this.consecutiveSuccesses = 0;
      this.nextAllowedAttemptAt = null;
      logger.info(`[CircuitBreaker:${this.name}] Transitioned ${oldState} -> CLOSED (Normal operation resumed)`);
    }
  }

  public async execute<T>(
    action: () => Promise<T>,
    fallback?: (err: Error) => Promise<T> | T
  ): Promise<T> {
    this.evaluateState();
    this.totalExecutions++;

    if (this.state === CircuitState.OPEN) {
      this.totalRejections++;
      const resetInMs = Math.max(0, (this.nextAllowedAttemptAt?.getTime() ?? Date.now()) - Date.now());
      const error = new CircuitBreakerOpenError(this.name, resetInMs);
      if (fallback) {
        return fallback(error);
      }
      throw error;
    }

    // Execute with timeout
    try {
      const result = await Promise.race([
        action(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Operation timed out after ${this.timeoutMs}ms in breaker '${this.name}'`)),
            this.timeoutMs
          )
        ),
      ]);

      this.onSuccess();
      return result;
    } catch (err: any) {
      this.onFailure(err);
      if (fallback) {
        return fallback(err instanceof Error ? err : new Error(String(err)));
      }
      throw err;
    }
  }

  private onSuccess(): void {
    this.lastSuccessAt = new Date();
    if (this.state === CircuitState.HALF_OPEN) {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
      }
    } else if (this.state === CircuitState.CLOSED) {
      this.failures = 0;
    }
  }

  private onFailure(err: any): void {
    this.failures++;
    this.totalFailures++;
    this.lastFailureAt = new Date();

    logger.warn(`[CircuitBreaker:${this.name}] Recorded failure (${this.failures}/${this.failureThreshold}): ${err?.message || err}`);

    if (this.state === CircuitState.HALF_OPEN) {
      // In canary/half-open mode, even 1 failure immediately kicks it back to OPEN
      this.transitionTo(CircuitState.OPEN);
    } else if (this.state === CircuitState.CLOSED && this.failures >= this.failureThreshold) {
      this.transitionTo(CircuitState.OPEN);
    }
  }

  public trip(): void {
    this.transitionTo(CircuitState.OPEN);
  }

  public reset(): void {
    this.transitionTo(CircuitState.CLOSED);
  }

  public getMetrics(): CircuitBreakerMetrics {
    this.evaluateState();
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalExecutions: this.totalExecutions,
      totalFailures: this.totalFailures,
      totalRejections: this.totalRejections,
      lastFailureAt: this.lastFailureAt?.toISOString() ?? null,
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
      lastStateChangeAt: this.lastStateChangeAt.toISOString(),
      nextAllowedAttemptAt: this.nextAllowedAttemptAt?.toISOString() ?? null,
    };
  }
}

class CircuitBreakerRegistryClass {
  private breakers = new Map<string, CircuitBreaker>();

  constructor() {
    // Pre-seed default core ISP integration breakers
    this.get('mikrotik', { failureThreshold: 3, resetTimeoutMs: 15000, timeoutMs: 5000 });
    this.get('sms_gateway', { failureThreshold: 4, resetTimeoutMs: 30000, timeoutMs: 8000 });
    this.get('payment_gateway', { failureThreshold: 3, resetTimeoutMs: 20000, timeoutMs: 10000 });
    this.get('external_webhook', { failureThreshold: 5, resetTimeoutMs: 45000, timeoutMs: 5000 });
  }

  public get(name: string, options?: CircuitBreakerOptions): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker(name, options);
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  public getAllMetrics(): Record<string, CircuitBreakerMetrics> {
    const result: Record<string, CircuitBreakerMetrics> = {};
    for (const [name, breaker] of this.breakers.entries()) {
      result[name] = breaker.getMetrics();
    }
    return result;
  }
}

export const CircuitBreakerRegistry = new CircuitBreakerRegistryClass();

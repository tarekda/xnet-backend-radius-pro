// eventBusSingleton.ts
import { EventBus } from './eventBus';

const eventBus = new EventBus();

eventBus.connect()
  .then(() =>{})
  .catch((err) => console.error('Failed to connect EventBus:', err));

/**
 * Closes the shared publisher connection. Errors are logged rather than
 * rethrown so a failed close cannot abort the rest of shutdown.
 */
export async function closeEventBus(): Promise<void> {
  try {
    await eventBus.close();
  } catch (err) {
    console.warn('EventBus close failed:', err instanceof Error ? err.message : err);
  }
}

export default eventBus;

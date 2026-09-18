import * as amqp from 'amqplib';
import { openUserActionsChannel, USER_ACTIONS_QUEUE } from './userActionsTopology';

export class EventBus {
  private connection!: any;
  private channel: amqp.Channel | undefined;
  private readonly queue = USER_ACTIONS_QUEUE;
  private readonly rabbitMqUrl = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

  async connect(): Promise<void> {
    try {
      console.log('Connecting to RabbitMQ at:', this.rabbitMqUrl);
      this.connection = await amqp.connect(this.rabbitMqUrl);
      this.connection.on('error', (err: unknown) => {
        console.error('EventBus connection error:', err);
      });

      // Shares the consumer's topology definition, so both sides declare the
      // queue with identical arguments.
      this.channel = await openUserActionsChannel(this.connection);
    } catch (error) {
      console.error('Error connecting to RabbitMQ:', error);
      throw error;
    }
  }

  isConnected(): boolean {
    return !!this.channel && this.connection && !this.connection.closed;
  }

  async publish(message: any): Promise<void> {
    if (!this.channel) {
      throw new Error('Channel is not initialized.');
    }
    
    try {
      // console.log('Publishing message to queue:', this.queue, 'Message:', message);
      
      const success = this.channel.sendToQueue(
        this.queue,
        Buffer.from(JSON.stringify(message)),
        { 
          persistent: true,
          contentType: 'application/json'
        }
      );
      
      if (!success) {
        console.warn('Message was not sent to queue - queue might be full');
      } else {
        // console.log('Message published successfully');
      }
    } catch (error) {
      console.error('Error publishing message:', error);
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      if (this.channel) {
        await this.channel.close();
      }
      if (this.connection) {
        await this.connection.close();
      }
    } catch (error) {
      console.error('Error closing RabbitMQ connection:', error);
      throw error;
    }
  }
}

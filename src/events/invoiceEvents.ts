import { EventEmitter } from 'events';
import eventBus from '../bus/eventBusSingleton';
import { ExternalInvoice } from '../db/entities/ExternalInvoice';

export interface InvoiceModification {
    invoiceId: number;
    username: string;
    action: 'UPDATED' | 'DELETED' | 'PAID' | 'UNPAID' | 'RECOVERED' | 'COLLECTED' | 'RECONCILED' | 'VOIDED';
    timestamp: Date;
    changes?: Record<string, any>;
    data?: any;
}

class InvoiceEventEmitter extends EventEmitter {
    async emitModification(modification: InvoiceModification) {
        // Emit local event
        this.emit('invoice:modification', modification);
        
        // Also publish to RabbitMQ
        try {
            if (!eventBus.isConnected()) {
                await eventBus.connect();
            }
            
            await eventBus.publish({
                type: 'INVOICE_MODIFICATION',
                title: 'Invoice Modified',
                message: `Invoice #${modification.invoiceId} username: ${modification.data?.username} has been ${modification.action.toLowerCase()}`,
                data: modification,
                timestamp: new Date()
            });
        } catch (error) {
            console.error('Error publishing invoice modification to RabbitMQ:', error);
        }
    }
}

export const invoiceEvents = new InvoiceEventEmitter();
import { Request, Response } from 'express';
import { bandwidthService } from '../services/bandwidthService';
import { Logger } from '../logging/logging';

const logger = Logger.getInstance();

export class BandwidthController {
  async getBandwidthSummary(req: Request, res: Response) {
    try {
      const summary = await bandwidthService.getBandwidthSummary();
      res.json({
        success: true,
        data: summary
      });
    } catch (error) {
      logger.error('Error getting bandwidth summary:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch bandwidth data',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async getNeighbors(req: Request, res: Response) {
    try {
      const neighbors = await bandwidthService.getNeighbors();
      res.json({
        success: true,
        data: neighbors
      });
    } catch (error) {
      logger.error('Error getting CCR neighbors:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch neighbors data',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async getInterfaceTraffic(req: Request, res: Response) {
    try {
      const traffic = await bandwidthService.getInterfaceTraffic();
      res.json({
        success: true,
        data: traffic
      });
    } catch (error) {
      logger.error('Error getting interface traffic:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch interface traffic data',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async getHistoricalTraffic(req: Request, res: Response) {
    try {
      const { interface: interfaceName, duration } = req.query;
      
      if (!interfaceName || typeof interfaceName !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Interface name is required'
        });
      }

      const durationNum = duration ? parseInt(duration as string) : 3600;
      const traffic = await bandwidthService.getHistoricalTraffic(interfaceName, durationNum);
      
      res.json({
        success: true,
        data: traffic
      });
    } catch (error) {
      logger.error('Error getting historical traffic:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch historical traffic data',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async getSystemResources(req: Request, res: Response) {
    try {
      const resources = await bandwidthService.getSystemResources();
      res.json({
        success: true,
        data: resources
      });
    } catch (error) {
      logger.error('Error getting system resources:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch system resources',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async testConnection(req: Request, res: Response) {
    try {
      const isConnected = await bandwidthService.testConnection();
      res.json({
        success: true,
        data: {
          connected: isConnected,
          timestamp: new Date()
        }
      });
    } catch (error) {
      logger.error('Error testing connection:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to test connection',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async getBandwidthMetrics(req: Request, res: Response) {
    try {
      const [summary, resources] = await Promise.all([
        bandwidthService.getBandwidthSummary(),
        bandwidthService.getSystemResources()
      ]);

      // Calculate bandwidth utilization percentages
      const totalBandwidth = 1000; // 1 Gbps in Mbps (rxRate/txRate are Mbps)
      const rxUtilization = (summary.totalRxRate / totalBandwidth) * 100;
      const txUtilization = (summary.totalTxRate / totalBandwidth) * 100;

      const metrics = {
        bandwidth: {
          download: {
            rate: summary.totalRxRate,
            bytes: summary.totalRxBytes,
            utilization: Math.min(rxUtilization, 100)
          },
          upload: {
            rate: summary.totalTxRate,
            bytes: summary.totalTxBytes,
            utilization: Math.min(txUtilization, 100)
          },
          total: {
            rate: summary.totalRxRate + summary.totalTxRate,
            bytes: summary.totalRxBytes + summary.totalTxBytes
          }
        },
        system: {
          cpuLoad: resources.cpuLoad,
          memoryUsage: ((resources.totalMemory - resources.freeMemory) / resources.totalMemory) * 100,
          uptime: resources.uptime
        },
        interfaces: summary.interfaces,
        timestamp: new Date()
      };

      res.json({
        success: true,
        data: metrics
      });
    } catch (error) {
      logger.error('Error getting bandwidth metrics:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch bandwidth metrics',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}

export const bandwidthController = new BandwidthController(); 
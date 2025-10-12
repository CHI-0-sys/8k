
class HealthMonitor {
    constructor(logger, bot) {
        this.logger = logger;
        this.bot = bot;
        this.metrics = {
            startTime: Date.now(),
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            rpcFailures: 0,
            apiFailures: 0,
            lastError: null,
            lastErrorTime: null,
            memoryUsage: {}
        };
        this.alerts = [];
        this.checkInterval = null;
    }

    start(intervalMinutes = 5) {
        this.logger.info('Health monitor started', { interval: intervalMinutes });
        
        this.checkInterval = setInterval(async () => {
            await this.runHealthChecks();
        }, intervalMinutes * 60 * 1000);

        this.runHealthChecks();
    }

    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.logger.info('Health monitor stopped');
        }
    }

    async runHealthChecks() {
        this.logger.debug('Running health checks');

        const checks = [
            this.checkMemory(),
            this.checkErrorRate()
        ];

        const results = await Promise.allSettled(checks);
        
        const failedChecks = results.filter(r => 
            r.status === 'fulfilled' && !r.value.healthy
        );

        if (failedChecks.length > 0) {
            await this.handleUnhealthyState(failedChecks);
        }

        return {
            healthy: failedChecks.length === 0,
            checks: results.map(r => r.status === 'fulfilled' ? r.value : { healthy: false })
        };
    }

    checkMemory() {
        const usage = process.memoryUsage();
        this.metrics.memoryUsage = {
            heapUsed: (usage.heapUsed / 1024 / 1024).toFixed(2) + ' MB',
            heapTotal: (usage.heapTotal / 1024 / 1024).toFixed(2) + ' MB',
            rss: (usage.rss / 1024 / 1024).toFixed(2) + ' MB'
        };

        const heapUsedMB = usage.heapUsed / 1024 / 1024;
        const heapTotalMB = usage.heapTotal / 1024 / 1024;
        const usagePercent = (heapUsedMB / heapTotalMB) * 100;

        const healthy = usagePercent < 90;

        if (!healthy) {
            this.logger.warn('High memory usage detected', { usagePercent: usagePercent.toFixed(2) });
        }

        return { name: 'memory', healthy, details: { usagePercent: usagePercent.toFixed(2), ...this.metrics.memoryUsage } };
    }

    checkErrorRate() {
        const totalRequests = this.metrics.totalRequests;
        const failedRequests = this.metrics.failedRequests;
        const errorRate = totalRequests > 0 ? (failedRequests / totalRequests) * 100 : 0;
        const healthy = errorRate < 20;

        if (!healthy) {
            this.logger.warn('High error rate detected', { errorRate: errorRate.toFixed(2) });
        }

        return {
            name: 'errors',
            healthy,
            details: {
                totalRequests,
                failedRequests,
                errorRate: errorRate.toFixed(2) + '%',
                lastError: this.metrics.lastError
            }
        };
    }

    recordRequest(success = true, type = 'general') {
        this.metrics.totalRequests++;
        if (success) {
            this.metrics.successfulRequests++;
        } else {
            this.metrics.failedRequests++;
            if (type === 'rpc') this.metrics.rpcFailures++;
            else if (type === 'api') this.metrics.apiFailures++;
        }
    }

    recordError(error, context = {}) {
        this.metrics.lastError = error.message;
        this.metrics.lastErrorTime = Date.now();
        this.logger.error('Error recorded', { error: error.message, context });
    }

    createAlert(severity, message, details = {}) {
        const alert = { severity, message, details, timestamp: Date.now(), acknowledged: false };
        this.alerts.push(alert);
        this.logger.warn('Alert created', alert);
        if (this.alerts.length > 100) this.alerts = this.alerts.slice(-100);
    }

    async handleUnhealthyState(failedChecks) {
        this.logger.error('System unhealthy', { failedChecks: failedChecks.map(c => c.value.name) });
        for (const check of failedChecks) {
            if (check.status === 'fulfilled') {
                this.createAlert('warning', `Health check failed: ${check.value.name}`, check.value.details);
            }
        }
    }

    getStatus() {
        const uptime = Date.now() - this.metrics.startTime;
        const uptimeHours = (uptime / (1000 * 60 * 60)).toFixed(2);

        return {
            healthy: this.alerts.filter(a => !a.acknowledged && a.severity === 'critical').length === 0,
            uptime: uptimeHours + ' hours',
            metrics: {
                ...this.metrics,
                successRate: this.metrics.totalRequests > 0 ?
                    ((this.metrics.successfulRequests / this.metrics.totalRequests) * 100).toFixed(2) + '%' : 'N/A'
            },
            activeAlerts: this.alerts.filter(a => !a.acknowledged).length,
            totalAlerts: this.alerts.length
        };
    }

    getDetailedReport() {
        return { ...this.getStatus(), recentAlerts: this.alerts.slice(-10).reverse() };
    }
}

module.exports = HealthMonitor;

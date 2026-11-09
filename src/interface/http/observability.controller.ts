import { Controller, Get, Res } from '@nestjs/common';
import { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics.ts';
import { Readiness, type ReadinessReport } from '../../infrastructure/observability/readiness.ts';

interface ResponseLike {
  status(code: number): void;
  setHeader(name: string, value: string): void;
}

@Controller()
export class ObservabilityController {
  constructor(
    private readonly metrics: PrometheusMetrics,
    private readonly readiness: Readiness,
  ) {}

  @Get('metrics')
  scrape(@Res({ passthrough: true }) response: ResponseLike): Promise<string> {
    response.setHeader('content-type', this.metrics.registry.contentType);
    return this.metrics.registry.metrics();
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) response: ResponseLike): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    response.status(report.ready ? 200 : 503);
    return report;
  }
}

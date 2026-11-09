import { Controller, Get, Res } from '@nestjs/common';
import { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics.ts';
import { DependencyProbes, type ReadinessReport } from '../../infrastructure/observability/dependency-probes.ts';

interface ResponseLike {
  status(code: number): void;
  setHeader(name: string, value: string): void;
}

@Controller()
export class ObservabilityController {
  constructor(
    private readonly metrics: PrometheusMetrics,
    private readonly probes: DependencyProbes,
  ) {}

  @Get('metrics')
  scrape(@Res({ passthrough: true }) response: ResponseLike): Promise<string> {
    response.setHeader('content-type', this.metrics.registry.contentType);
    return this.metrics.registry.metrics();
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) response: ResponseLike): Promise<ReadinessReport> {
    const report = await this.probes.readiness();
    response.status(report.ready ? 200 : 503);
    return report;
  }
}

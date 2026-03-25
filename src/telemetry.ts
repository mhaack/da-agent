// src/telemetry.ts
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { LangfuseExporter } from 'langfuse-vercel';

let initialized = false;
let exporter: LangfuseExporter | null = null;

export function initTelemetry(env: Env): void {
  if (initialized) return;

  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    console.warn('Telemetry: LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY not set, skipping telemetry setup');
    return;
  }

  exporter = new LangfuseExporter({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_BASEURL || 'https://cloud.langfuse.com',
  });

  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);

  initialized = true;
}

export async function flushTelemetry(): Promise<void> {
  if (exporter) {
    try {
      await exporter.forceFlush();
    } catch (e) {
      console.error('Telemetry: failed to flush spans:', e);
    }
  }
}

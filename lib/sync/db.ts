export interface D1ResultPort<T = Record<string, unknown>> {
  success: boolean;
  results?: T[];
  meta?: { changes?: number; [key: string]: unknown };
  error?: string;
}

export interface D1PreparedStatementPort {
  bind(...values: unknown[]): D1PreparedStatementPort;
  all<T = Record<string, unknown>>(): Promise<D1ResultPort<T>>;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1ResultPort<T>>;
}

export interface D1DatabasePort {
  prepare(query: string): D1PreparedStatementPort;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatementPort[],
  ): Promise<D1ResultPort<T>[]>;
}

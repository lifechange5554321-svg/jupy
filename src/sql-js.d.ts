declare module "sql.js" {
  type SqlDatabase = {
    exec(sql: string): { columns: string[]; values: unknown[][] }[];
    close(): void;
  };
  type SqlJs = { Database: new (data?: Uint8Array) => SqlDatabase };
  export default function initSqlJs(opts?: { locateFile?: (file: string) => string }): Promise<SqlJs>;
}

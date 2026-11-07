export const build = (schema: string): string => `select * from ${schema}.projects`;
export const worse = 'set search_path to tenant_globex';

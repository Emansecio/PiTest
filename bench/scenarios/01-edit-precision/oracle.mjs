import { check, importSandbox, pass } from "../_helpers.mjs";

const { config: c } = await importSandbox("config.mjs");
check(c, "config.mjs deve exportar `config`");
check(c.retryMs === 2500, `retryMs deveria ser 2500, é ${c.retryMs}`);
check(c.timeoutMs === 1000, `timeoutMs foi alterado (${c.timeoutMs}) — deveria continuar 1000`);
check(c.pollMs === 1000, `pollMs foi alterado (${c.pollMs}) — deveria continuar 1000`);
check(c.backoffMs === 1000, `backoffMs foi alterado (${c.backoffMs}) — deveria continuar 1000`);
check(c.port === 8080, `port mudou (${c.port})`);
check(c.host === "localhost", `host mudou (${c.host})`);
check(c.maxRetries === 3, `maxRetries mudou (${c.maxRetries})`);
check(c.verbose === false, `verbose mudou (${c.verbose})`);
pass("retryMs=2500 e todos os outros campos intactos");

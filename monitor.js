'use strict';

const fs = require('fs').promises;

const C = {
  reset:  '\x1b[0m',  bold:   '\x1b[1m',
  red:    '\x1b[31m', green:  '\x1b[32m',
  yellow: '\x1b[33m', blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
};

class HttpClient {
  async request(url, { timeoutMs = 5_000, ...opts } = {}) {
    const start = Date.now();
    try {
      // Menggunakan Native AbortSignal (Node v17.3+) untuk efisiensi memori
      const res = await fetch(url, { 
        ...opts, 
        signal: AbortSignal.timeout(timeoutMs) 
      });
      const duration = Date.now() - start;
      const isJson = res.headers.get('content-type')?.includes('application/json');
      const body = isJson ? await res.json() : await res.text();
      
      return { status: res.status, duration, body };
    } catch (err) {
      err.duration = Date.now() - start;
      throw err;
    }
  }

  get(url, opts = {}) {
    return this.request(url, { method: 'GET', ...opts });
  }
}

class Assertion {
  constructor(response) {
    this.response = response;
    this.errors = [];
  }
  expectStatus(expected) {
    if (this.response.status !== expected)
      this.errors.push(`Status › expected ${expected}, got ${this.response.status}`);
    return this;
  }
  expectMaxDuration(maxMs) {
    if (this.response.duration > maxMs)
      this.errors.push(`Duration › ${this.response.duration}ms exceeds ${maxMs}ms`);
    return this;
  }
  get passed() { return this.errors.length === 0; }
}

class Notifier {
  sendAlert(message) {
    const ts = new Date().toLocaleTimeString();
    console.error(`${C.bold}${C.red}[FAIL]${C.reset} ${C.yellow}${ts}${C.reset}  ${C.red}${message}${C.reset}`);
  }
  sendSuccess(name, { status, duration }) {
    const ts = new Date().toLocaleTimeString();
    console.log(`${C.bold}${C.green}[ OK ]${C.reset} ${C.yellow}${ts}${C.reset}  ${name}  ${C.cyan}HTTP ${status}${C.reset}  ${duration}ms`);
  }
  printDivider(baseUrl) {
    console.log(`\n${C.bold}${C.blue}━━━ ${baseUrl} ─ ${new Date().toISOString()} ━━━${C.reset}`);
  }
}

class SmartDiscovery {
  #baseUrl;
  #client;

  constructor(baseUrl) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#client = new HttpClient();
  }

  async discoverEndpoints() {
    console.log(`\n${C.bold}${C.cyan}🔍 Smart discovery: ${this.#baseUrl}${C.reset}`);
    
    // Mengeksekusi Swagger dan GraphQL secara konruen (Paralel)
    const [swagger, graphql] = await Promise.all([
      this.#trySwagger(),
      this.#tryGraphQL()
    ]);

    if (swagger.length > 0) return swagger;
    if (graphql.length > 0) return graphql;

    // Fallback jika tidak ada, jalankan common paths secara paralel
    return await this.#tryCommonPaths();
  }

  async #trySwagger() {
    const swaggerPaths = ['/swagger.json', '/openapi.json', '/api-docs', '/v3/api-docs', '/api/openapi.json'];
    
    // Optimasi: Request paralel menggunakan Promise.allSettled
    const promises = swaggerPaths.map(path => 
      this.#client.request(`${this.#baseUrl}${path}`, { timeoutMs: 3_000 })
        .then(res => ({ path, res }))
    );

    const results = await Promise.allSettled(promises);
    
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.res.status === 200 && typeof result.value.res.body === 'object') {
        console.log(`${C.green}✓ Found OpenAPI spec at ${result.value.path}${C.reset}`);
        return this.#parseOpenAPI(result.value.res.body);
      }
    }
    return [];
  }

  #parseOpenAPI(spec) {
    const endpoints = [];
    const paths = spec.paths || {};
    const validMethods = new Set(['get', 'post', 'put', 'delete', 'patch']);

    for (const [path, methods] of Object.entries(paths)) {
      for (const method of Object.keys(methods)) {
        if (validMethods.has(method)) {
          endpoints.push({
            name: `${new URL(this.#baseUrl).hostname} › ${method.toUpperCase()} ${path}`,
            url: `${this.#baseUrl}${path}`,
            method: method.toUpperCase(),
            assertions: { status: 200, maxDuration: 3000 }
          });
        }
      }
    }
    console.log(`${C.green}✓ Parsed ${endpoints.length} endpoint(s) from spec${C.reset}`);
    return endpoints;
  }

  async #tryGraphQL() {
    try {
      const url = `${this.#baseUrl}/graphql`;
      const query = `{ __schema { queryType { name } } }`;
      const response = await this.#client.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        timeoutMs: 3_000
      });

      if (response.status === 200 && response.body.data) {
        console.log(`${C.green}✓ GraphQL endpoint detected at /graphql${C.reset}`);
        return [{
          name: `${new URL(this.#baseUrl).hostname} › POST /graphql`,
          url: `${this.#baseUrl}/graphql`,
          method: 'POST',
          assertions: { status: 200, maxDuration: 3000 }
        }];
      }
    } catch (err) {
      console.warn("Sorry we couldn't find a GraphQL endpoint at /graphql");
    }
    return [];
  }

  async #tryCommonPaths() {
    const commonPaths = [
      '/api/docs', '/docs', '/api', '/v1', '/v2', '/v3',
      '/health', '/status', '/ping', '/info',
      '/users', '/posts', '/comments', '/products', '/items',
      '/articles', '/categories', '/tasks', '/todos', '/data'
    ];

    const endpoints = [];
    
    // Optimasi: Mapping concurrent promises agar request tidak blocking
    const promises = commonPaths.map(async (path) => {
      const url = `${this.#baseUrl}${path}`;
      const response = await this.#client.request(url, { timeoutMs: 2_000 });
      if (response.status < 400) {
        endpoints.push({
          name: `${new URL(this.#baseUrl).hostname} › GET ${path}`,
          url,
          method: 'GET',
          assertions: { status: 200, maxDuration: 3000 }
        });
        console.log(`${C.green}✓${C.reset} Found: ${path}`);
      }
    });

    // Tunggu semua concurrent request selesai
    await Promise.allSettled(promises);

    if (endpoints.length > 0) {
      console.log(`${C.green}✓ Found ${endpoints.length} endpoint(s) via common paths${C.reset}`);
    }
    return endpoints;
  }
}

class APIMonitor {
  #endpoints;
  #intervalMs;
  #client;
  #notifier;
  #timer;

  constructor(endpoints, intervalMs = 15_000) {
    this.#endpoints = endpoints;
    this.#intervalMs = intervalMs;
    this.#client = new HttpClient();
    this.#notifier = new Notifier();
    this.#timer = null;
  }

  async checkEndpoint({ name, url, method = 'GET', assertions = {} }) {
    try {
      const response = await this.#client.request(url, { method, timeoutMs: 5_000 });
      const assert = new Assertion(response);
      
      if (assertions.status) assert.expectStatus(assertions.status);
      if (assertions.maxDuration) assert.expectMaxDuration(assertions.maxDuration);

      assert.passed
        ? this.#notifier.sendSuccess(name, response)
        : assert.errors.forEach(err => this.#notifier.sendAlert(`[${name}] ${err}`));
    } catch (err) {
      this.#notifier.sendAlert(`[${name}] Unreachable › ${err.name === 'TimeoutError' ? 'Connection Timed Out' : err.message}`);
    }
  }

  async runCycle(baseUrl) {
    this.#notifier.printDivider(baseUrl);
    // Jalankan pengecekan endpoint secara paralel
    await Promise.all(this.#endpoints.map(ep => this.checkEndpoint(ep)));
  }

  start(baseUrl) {
    console.log(`${C.bold}${C.green}▶ Monitoring: ${baseUrl}${C.reset}  endpoints: ${this.#endpoints.length}\n`);
    this.runCycle(baseUrl);
    this.#timer = setInterval(() => this.runCycle(baseUrl), this.#intervalMs);
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
  }
}

async function main() {
  const CONFIG_FILE = 'url.json';
  let config;

  try {
    const fileData = await fs.readFile(CONFIG_FILE, 'utf-8');
    config = JSON.parse(fileData);
  } catch (err) {
    console.error(`${C.red}[ERROR]${C.reset} Gagal membaca atau mem-parsing file ${CONFIG_FILE}.`);
    console.error(`Pastikan file ${CONFIG_FILE} ada dan berformat JSON valid. Error: ${err.message}`);
    process.exit(1);
  }

  const urls = config.urls || [];
  const interval = config.intervalMs || 15_000;

  if (!Array.isArray(urls) || urls.length === 0) {
    console.error(`${C.red}[ERROR]${C.reset} Array 'urls' di dalam ${CONFIG_FILE} kosong atau tidak valid.`);
    process.exit(1);
  }

  const monitors = [];

  
  console.log(`${C.cyan}Memulai proses discovery untuk ${urls.length} target...${C.reset}`);
  
  for (const baseUrl of urls) {
    try {
      const discovery = new SmartDiscovery(baseUrl);
      const endpoints = await discovery.discoverEndpoints();

      if (endpoints.length === 0) {
        console.warn(`${C.yellow}⚠ No endpoints found for ${baseUrl}${C.reset}`);
        continue;
      }

      const monitor = new APIMonitor(endpoints, interval);
      monitor.start(baseUrl);
      monitors.push(monitor);

    } catch (err) {
      console.error(`${C.red}[ERROR]${C.reset} Failed to setup monitoring for ${baseUrl}: ${err.message}`);
    }
  }

  if (monitors.length === 0) {
    console.error(`${C.red}[ERROR]${C.reset} No monitors started. Cek kembali target URL Anda.`);
    process.exit(1);
  }

  console.log(`\n${C.bold}${C.green}✓ Monitoring ${monitors.length} API(s) continuously...${C.reset}`);
  console.log(`${C.yellow}Press Ctrl+C to stop${C.reset}\n`);

  process.on('SIGINT', () => {
    console.log(`\n${C.yellow}■ Stopping monitors gracefully...${C.reset}`);
    monitors.forEach(m => m.stop());
    process.exit(0);
  });
}

main().catch(err => {
  console.error(`${C.red}[CRITICAL ERROR]${C.reset}`, err);
  process.exit(1);
});
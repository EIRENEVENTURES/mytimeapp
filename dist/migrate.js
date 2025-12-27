"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = require("path");
const db_1 = require("./db");
async function run() {
    const dir = (0, path_1.join)(__dirname, '..', 'sql');
    const files = (0, fs_1.readdirSync)(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    for (const file of files) {
        const fullPath = (0, path_1.join)(dir, file);
        const sql = (0, fs_1.readFileSync)(fullPath, 'utf8');
        // eslint-disable-next-line no-console
        console.log(`Running migration: ${file}`);
        await db_1.pool.query(sql);
    }
    await db_1.pool.end();
}
run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Migration failed', err);
    process.exit(1);
});

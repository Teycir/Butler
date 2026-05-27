import dotenv from 'dotenv';
import { initDatabase, closeDatabase, getDb } from './db/database.js';
import { startLifecycleMonitor, stopLifecycleMonitor } from './coordinator/lifecycle.js';
import { materializeProject } from './events/materializer.js';
import { ButlerMcpServer } from './mcp/server.js';
// Load environmental variables
dotenv.config();
async function main() {
    try {
        // 1. Initialize SQLite Database
        initDatabase();
        // 2. Start session stale/dead tracking monitor
        startLifecycleMonitor();
        // 3. Start Model Context Protocol stdio server
        const mcpServer = new ButlerMcpServer();
        await mcpServer.run();
        // 4. Register exit hooks for graceful release
        let isShuttingDown = false;
        const cleanUp = () => {
            if (isShuttingDown)
                return;
            isShuttingDown = true;
            stopLifecycleMonitor();
            // Trigger snapshot before shutdown
            try {
                const db = getDb();
                const projects = db.prepare('SELECT id FROM projects').all();
                for (const project of projects) {
                    materializeProject(project.id, true);
                }
            }
            catch (e) {
                console.error('Snapshot on shutdown failed:', e);
            }
            closeDatabase();
            process.exit(0);
        };
        process.on('SIGINT', cleanUp);
        process.on('SIGTERM', cleanUp);
    }
    catch (error) {
        console.error('Fatal initialization error in Butler:', error);
        stopLifecycleMonitor();
        closeDatabase();
        process.exit(1);
    }
}
main();

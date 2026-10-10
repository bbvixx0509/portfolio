import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(serverDir, '..');
const rootDir = path.resolve(backendDir, '..');

dotenv.config({ path: path.join(rootDir, '.env'), quiet: true });
dotenv.config({ path: path.join(backendDir, '.env'), override: true, quiet: true });

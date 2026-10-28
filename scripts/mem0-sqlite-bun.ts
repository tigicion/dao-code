// Mem0 用到的 exec/prepare/transaction 与 bun:sqlite 兼容。
// 编译时替换原生 Node addon,确保单文件可在没有 node_modules 的机器上运行。
import { Database } from "bun:sqlite";
export default class Mem0Sqlite extends Database {
  constructor(filename: string) {
    super(filename, { create: true, strict: true });
    this.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL");
  }
}

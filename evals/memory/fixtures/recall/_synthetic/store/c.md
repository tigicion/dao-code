---
name: c
title: Postgres 连接池调优笔记
type: semantic
importance: 4
uses: 1
created: 2026-05-10
lastUsed: 2026-05-12
status: active
locked: false
---
后端 Postgres 连接池用 PgBouncer transaction 模式,max_client_conn 设为 200。

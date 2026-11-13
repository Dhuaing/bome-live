@echo off
rem Bome duty: daily 21:00 via scheduled task bome-duty
rem Idempotent: local checkup + cloud readback + ops log (--auto commits log)
rem NOTE: keep this file ANSI(GBK) encoded + CRLF line endings (cmd batch rules);
rem       UTF-8 or LF-only breaks parsing (incident 2026-11-13, 6 silent nights).
cd /d D:\Ð¡³ÌÐò
D:\node.exe scripts\duty.js --auto
@echo off
rem 「播了么」自动值班：每天 21:00 由计划任务 bome-duty 调用
rem 幂等：本地体检 + 读云端自检 + 写运维日志（--auto 仅提交日志）
cd /d D:\小程序
D:\node.exe scripts\duty.js --auto

import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
test("offline maintenance preserves file identity, partial state, reentry and native exclusive handles", async()=>{
 const {stdout,stderr}=await promisify(execFile)(process.env.WM_TEST_PYTHON ?? (process.platform==="win32"?"python":"python3"),["tests/test_maintenance.py"],{timeout:30000});
 assert.match(stdout+stderr,/OK/);
});

// @vitest-environment node
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
let directory:string|null=null;
let database:typeof import('./index.js')|null=null;
afterEach(()=>{database?.default.close();database=null;if(directory)rmSync(directory,{recursive:true,force:true});directory=null;vi.unstubAllEnvs();vi.resetModules();});
it('keeps existing backup schema compatible and invalidates operational postpone receipts on restore',async()=>{
 directory=mkdtempSync(path.join(tmpdir(),'tkd-postpone-backup-'));vi.stubEnv('DATA_DIR',directory);vi.resetModules();
 database=await import('./index.js');const backup=await import('./full-backup.js');const postpone=await import('./match-postpone.js');
 const request={requestId:'before-restore',categoryId:'c',matchId:'f',expectedRevision:0,expectedLoadId:'old-load'};
 database.default.prepare('INSERT INTO match_postpone_receipts(request_id,fingerprint) VALUES (?,?)').run(request.requestId,JSON.stringify(['c','f',0,'old-load']));
 expect(postpone.hasPostponeReceipt(request)).toBe(true);
 const snapshot=backup.captureSqlBackup();expect(Object.keys(snapshot.tables)).not.toContain('match_postpone_receipts');
 backup.restoreSqlBackup(snapshot,'backup-id','payload-hash','browser-hash');
 expect(postpone.hasPostponeReceipt(request)).toBe(false);expect(database.loadMatchSnapshot()).toBeNull();
 expect(()=>postpone.releaseNeverStartedMatch(request)).toThrow('stale_match_context');
});

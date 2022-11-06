import { fromB64urlQuery } from "project-sock";
import { request } from "@octokit/request";
import { simpleGit } from 'simple-git';
import { toSign } from "../create.js";
import path from 'node:path';
import fs from 'fs'

import type { TreeAny, NodeAny } from "project-sock"
import type { UserInstallRaw } from "../create.js";
import type { UserInstall } from "../create.js";
import type { AppOutput } from "../create.js";
import type { Secrets } from "./encrypt.js";
import type { Git } from "./types.js";

export type HasGit = { git: Git }
export type WikiConfig = {
  home: string,
  tmp: string
}
export type UserIn = HasGit & {
  delay: number,
  prod: boolean,
  wiki_config: WikiConfig
}
type InstallIn = HasGit & {
  delay: number,
  app: AppOutput
}
type ItemInC = {
  "body": Uint8Array,
  "mac_tag": Uint8Array
}
type ServerAuthData = {
  As: Uint8Array,
  Xs: Uint8Array,
  beta: Uint8Array,
  c: Record<"pu" | "Pu" | "Ps", ItemInC>
}
export type Pasted = {
  C: Secrets,
  S?: ServerAuthData
}
export type UserApp = Pasted & {
  S: ServerAuthData
}
interface ToUserInstall {
  (u: InstallIn): Promise<Obj>;
}
interface ReadUserInstall {
  (u: InstallIn): Promise<UserInstall>;
}
interface ReadUserApp {
  (u: UserIn): Promise<UserApp>;
}
interface ToPasted {
  (s: string) : Promise<TreeAny>
}
type GitOutput = {
  repo_url: string,
  tmp_dir: string,
  tmp_file: string
}
interface DoGit {
  (i: UserIn): Promise<void> 
}
interface UseGit {
  (i: UserIn): GitOutput
}
type Obj = Record<string, unknown>;

function isObj(u: unknown): u is Obj {
  return u != null && typeof u === "object";
}
export function isTree(u: NodeAny): u is TreeAny {
  return u != null && typeof u === "object";
}

function hasCode(o: TreeAny): o is Pasted {
  if (!isTree(o.C)) {
    return false;
  }
  const { salt, key, data } = o.C;
  if (!isTree(key) || !isTree(data)) {
    return false;
  }
  const needs = [
    data.iv, data.tag, data.ev,
    salt, key.iv, key.tag, key.ev
  ];
  return needs.every(v => v instanceof Uint8Array);
}

function isForInstall(o: Obj): o is UserInstallRaw {
  if (!isObj(o)) {
    return false;
  }
  const needs = [
    typeof o.id === "number",
    isObj(o.permissions)
  ];
  return needs.every(v => v);
}

const useGit: UseGit = ({ git, wiki_config }) => {
  const { owner, repo } = git;
  const { tmp, home } = wiki_config;
  const login = `git@github.com`;
  const wiki = `${repo}.wiki`;
  const repo_url = `https://${login}/${owner}/${wiki}.git`;
  const tmp_dir = path.relative(process.cwd(), tmp);
  const tmp_file = path.join(tmp_dir, wiki, home);
  return { repo_url, tmp_dir, tmp_file };
}

const pullGit: DoGit = async (input) => {
  const { tmp_file, tmp_dir } = useGit(input);
  const wiki_dir = path.dirname(tmp_file);
  const git_opts = {
    binary: 'git',
    baseDir: tmp_dir
  }
  const github = simpleGit(git_opts);
  await github.cwd(wiki_dir);
  await github.pull();
}

const cloneGit: DoGit = async (input) => {
  const { repo_url, tmp_dir } = useGit(input);
  const git_opts = {
    binary: 'git',
    baseDir: tmp_dir
  }
  if (fs.existsSync(tmp_dir)){
    const rf = { recursive: true, force: true };
    fs.rmSync(tmp_dir, rf);
  }
  fs.mkdirSync(tmp_dir);
  const github = simpleGit(git_opts);
  await github.clone(repo_url);
}

const toPasted: ToPasted = async (src) => {
  const encoding = 'utf-8';
  const txt = fs.readFileSync(src, { encoding });
  const text = txt.replaceAll('\n', '');
  return fromB64urlQuery(text);
}

function isForApp(o: Pasted): o is UserApp {
  const d = o?.S;
  if (!d || !isTree(d)) {
    return false;
  }
  if (!isTree(d.c)) {
    return false;
  }
  if (!isTree(d.c.pu) || !isTree(d.c.Pu) || !isTree(d.c.Ps)) {
    return false;
  }
  const needs = [
    d.beta, d.Xs, d.As,
    d.c.pu.body, d.c.Pu.body, d.c.Ps.body,
    d.c.pu.mac_tag, d.c.Pu.mac_tag, d.c.Ps.mac_tag
  ];
  return needs.every(v => v instanceof Uint8Array);
}

const readUserApp: ReadUserApp = async (ins) => {
  let tries = 0;
  const min15 = 60 * 15;
  const dt = ins.delay * 1000;
  const max_tries = min15 / ins.delay;
  const { tmp_file: src } = useGit(ins);
  if (ins.prod) {
    await cloneGit(ins);
  }
  while (tries < Math.ceil(max_tries)) {
    await new Promise(r => setTimeout(r, dt));
    const pasted = await toPasted(src);
    if (hasCode(pasted) && isForApp(pasted)) {
      return pasted;
    }
    if (ins.prod) {
      await pullGit(ins);
    }
    tries += 1;
  }
  throw new Error("Timeout waiting for GitHub App");
}


const toUserInstall: ToUserInstall = async (ins) => {
  const authorization = 'bearer ' + toSign(ins.app);
  const api_url = '/users/{username}/installation';
  const out = await request(`GET ${api_url}`, {
    username: ins.git.owner,
    headers: { authorization }
  })
  return out.data;
}

const readUserInstall: ReadUserInstall = async (ins) => {
  let tries = 0;
  const min15 = 60 * 15;
  const dt = ins.delay * 1000;
  const max_tries = min15 / ins.delay;
  console.log('Awaiting app installation...');
  while (tries < Math.ceil(max_tries)) {
    await new Promise(r => setTimeout(r, dt));
    let install: Obj = {};
    try {
      install = await toUserInstall(ins);
    }
    catch (e: any) {
      if (e?.status !== 404) throw e;
    }
    if (isForInstall(install)) {
      return {
        git: ins.git,
        app: ins.app,
        id: install.id,
        permissions: install.permissions
      };
    }
    tries += 1;
  }
  throw new Error("Timeout waiting for installation");
}

export { readUserApp, readUserInstall }

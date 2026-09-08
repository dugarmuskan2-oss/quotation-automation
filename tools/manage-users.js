'use strict';

/**
 * Add, list or remove the people who can log in.
 *
 *   node tools/manage-users.js list
 *   node tools/manage-users.js add "Muskan" muskan@dscpipes.com
 *   node tools/manage-users.js remove muskan@dscpipes.com
 *
 * The password is TYPED IN, never passed as an argument: an argument is visible to every other
 * process on the machine and lands in the shell's history file. Only the scrypt hash is stored,
 * so the list is useless to anyone who gets hold of it, and nobody — including whoever runs
 * this — can read a password back out of it.
 *
 * Writes to whichever site the local .env points at: CONFIG_PREFIX decides, so with it set to
 * "m/" this manages the m@dscpipes.com people instead. The tool says which before it writes.
 */

const path = require('path');
const readline = require('readline');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const storage = require('../storage');
const { CONFIG_KEY_USERS, configKey } = require('../utils/constants');
const { hashPassword } = require('../utils/auth');

function askHidden(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        const onData = (char) => {
            // Redraw the prompt with nothing after it, so the password never appears on screen.
            if (['\n', '\r', ''].indexOf(String(char)) < 0) {
                readline.clearLine(process.stdout, 0);
                readline.cursorTo(process.stdout, 0);
                process.stdout.write(question);
            }
        };
        process.stdin.on('data', onData);
        rl.question(question, (answer) => {
            process.stdin.removeListener('data', onData);
            rl.close();
            process.stdout.write('\n');
            resolve(answer);
        });
    });
}

async function loadUsers() {
    const raw = await storage.readText(CONFIG_KEY_USERS);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        throw new Error('users.json exists but could not be read — refusing to overwrite it: ' + e.message);
    }
}

const saveUsers = (users) => storage.saveText(CONFIG_KEY_USERS, JSON.stringify(users, null, 2));
const label = (u) => (u.name || '(no name)') + '  <' + (u.email || 'no email') + '>';

async function main() {
    const [command, arg1, arg2] = process.argv.slice(2);
    const where = configKey(CONFIG_KEY_USERS);
    console.log('people list: ' + where + (where.indexOf('/') >= 0 ? '   (the second setup)' : '   (the main site)') + '\n');

    const users = await loadUsers();

    if (!command || command === 'list') {
        if (!users.length) {
            console.log('Nobody has their own login yet.');
            console.log('Until someone does, the shared APP_PASSWORD is the only way in.');
            return;
        }
        users.forEach((u, i) => console.log('  ' + (i + 1) + '. ' + label(u)));
        return;
    }

    if (command === 'add') {
        const name = String(arg1 || '').trim();
        const email = String(arg2 || '').trim().toLowerCase();
        if (!name || !email) { console.error('Usage: node tools/manage-users.js add "Full Name" email@dscpipes.com'); process.exit(1); }
        const password = await askHidden('Password for ' + name + ': ');
        const again = await askHidden('Type it again: ');
        if (!password || password.length < 8) { console.error('Too short — use at least 8 characters.'); process.exit(1); }
        if (password !== again) { console.error('Those did not match. Nothing was changed.'); process.exit(1); }

        const existing = users.findIndex((u) => String(u.email || '').toLowerCase() === email);
        const record = { name, email, hash: hashPassword(password) };
        if (existing >= 0) { users[existing] = record; console.log('Updated ' + label(record)); }
        else { users.push(record); console.log('Added ' + label(record)); }
        await saveUsers(users);
        console.log('Saved. ' + users.length + ' ' + (users.length === 1 ? 'person' : 'people') + ' can sign in.');
        return;
    }

    if (command === 'remove') {
        const email = String(arg1 || '').trim().toLowerCase();
        const kept = users.filter((u) => String(u.email || '').toLowerCase() !== email);
        if (kept.length === users.length) { console.error('No login found for ' + email); process.exit(1); }
        // Removing the last person would leave only the shared password — fine, but say so, since
        // with no APP_PASSWORD set either it would leave the site open to anyone.
        if (!kept.length) {
            console.log('That was the last person with their own login.');
            console.log(process.env.APP_PASSWORD
                ? 'The shared password still works.'
                : 'WARNING: no shared password is set either — the site will be OPEN to anyone with the address.');
        }
        await saveUsers(kept);
        console.log('Removed ' + email + '. ' + kept.length + ' left.');
        return;
    }

    console.error('Unknown command. Use: list | add | remove');
    process.exit(1);
}

main().catch((e) => { console.error('Failed: ' + e.message); process.exit(1); });

import type { Game, DialogueOption } from '../game/game';
import { SHOP_STOCK } from '../game/game';
import type { Furniture, GenParams } from '../world/types';
import type { NpcState } from '../sim/types';
import type { Ending } from '../game/story';
import { ITEMS, itemName } from '../sim/items';
import { fullName, JOB_TITLE, heightClass, hairName } from '../sim/population';
import { formatClock, wrapAngle, clamp } from '../core/math';
import { listSaves, deleteSave, SLOTS } from '../game/save';
import { DEFAULT_BINDINGS, type Action } from '../game/input';
import { ATTR_LABEL } from '../game/journal';
import { DEFAULT_SETTINGS, KEY_CODE } from '../game/settings';
import { memoryLine } from '../sim/memory';
import * as THREE from 'three';

type Child = Node | string | null | undefined | false;

function h(tag: string, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'disabled') (el as HTMLButtonElement).disabled = !!v;
    else if (k === 'value') (el as HTMLInputElement).value = String(v);
    else if (k === 'checked') (el as HTMLInputElement).checked = !!v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

const btn = (text: string, onclick: () => void, cls = '', disabled = false) => h('button', { class: cls, onclick, disabled, 'data-label': text }, text);

interface Msg {
  el: HTMLElement;
  t: number;
}

export class UI {
  root: HTMLElement;
  private layer: HTMLElement; // modal screens
  private hud: HTMLElement;
  private hudEls: Record<string, HTMLElement> = {};
  private messages: Msg[] = [];
  private bubbles = new Map<number, { el: HTMLElement; until: number }>();
  endingShown = false;
  private hudT = 0;
  private journalTab = 'objectives';
  private fadeEl: HTMLElement;
  private bannerEl: HTMLElement;
  private obsEl: HTMLElement | null = null;
  private obsT = 0;
  private dialogKind = '';
  /** result of the last save, shown on the next saves screen */
  private saveNotice = '';

  constructor(private game: Game) {
    this.root = document.getElementById('ui')!;
    this.hud = h('div', { id: 'hud' });
    this.layer = h('div', { id: 'layer' });
    this.fadeEl = h('div', { class: 'fade' }, h('div', { class: 'click-hint', style: 'top:48%;color:#cfc6b0;font-size:20px' }));
    this.bannerEl = h('div', { class: 'banner' });
    this.root.append(this.hud, this.fadeEl, this.bannerEl, this.layer);
    this.buildHud();
    this.hud.style.display = 'none';
  }

  // ------------------------------------------------------------------ helpers

  private screen(...children: Child[]) {
    this.layer.innerHTML = '';
    const s = h('div', { class: 'screen' }, ...children);
    this.layer.append(s);
    return s;
  }

  hideAll() {
    this.layer.innerHTML = '';
    this.dialogKind = '';
    const inGame = this.game.mode === 'playing' || this.game.mode === 'dialog';
    this.hud.style.display = inGame ? '' : 'none';
    if (this.obsEl && this.game.mode !== 'observer') {
      this.obsEl.remove();
      this.obsEl = null;
      this.obsParts = null;
    }
  }

  showError(text: string) {
    const s = this.screen(h('div', { class: 'panel' }, h('h2', {}, 'Something went wrong'), h('p', {}, text), h('div', { class: 'buttons' }, btn('OK', () => this.showMainMenu()))));
    void s;
  }

  message(text: string, kind: 'info' | 'warn' | 'good' | 'event' = 'info') {
    const box = this.hudEls.messages;
    if (!box) return;
    const el = h('div', { class: kind }, text);
    box.append(el);
    this.messages.push({ el, t: performance.now() });
    while (this.messages.length > 6) this.messages.shift()!.el.remove();
  }

  banner(title: string, sub = '') {
    this.bannerEl.innerHTML = '';
    this.bannerEl.append(title.toUpperCase(), sub ? h('small', {}, sub) : '');
    this.bannerEl.style.opacity = '1';
    setTimeout(() => (this.bannerEl.style.opacity = '0'), 3500);
  }

  fade(on: boolean, text = '') {
    this.fadeEl.style.opacity = on ? '0.92' : '0';
    (this.fadeEl.firstChild as HTMLElement).textContent = text;
  }

  speech(actor: number, text: string) {
    const old = this.bubbles.get(actor);
    if (old) old.el.remove();
    const sim = this.game.sim!;
    const n = sim.npc(actor);
    const name = n && sim.player.knownTo.includes(actor) ? fullName(n) : n ? 'Neighbour' : '';
    const el = h('div', { class: 'bubble' }, name ? h('span', { class: 'who' }, name) : '', text);
    this.hud.append(el);
    this.bubbles.set(actor, { el, until: performance.now() + 4500 });
  }

  // ------------------------------------------------------------------ menus

  showMainMenu() {
    this.hud.style.display = 'none';
    this.endingShown = false;
    const saves = listSaves().filter((s) => s.valid);
    const latest = saves.sort((a, b) => b.savedAt - a.savedAt)[0];
    this.screen(
      h('h1', { class: 'title' }, 'Night Neighbour'),
      h('div', { class: 'subtitle' }, 'Somebody on your street is not who they seem.'),
      h(
        'div',
        { class: 'menu-col' },
        latest ? btn('Continue', () => this.load(latest.slot), 'primary') : null,
        btn('New Game', () => this.showNewGame(), latest ? '' : 'primary'),
        btn('Load Game', () => this.showSaves(false)),
        btn('Observer Mode', () => this.showNewGame(true)),
        btn('Settings', () => this.showSettings(() => this.showMainMenu())),
        btn('How to Play', () => this.showHelp(() => this.showMainMenu())),
        btn('Credits', () => this.showCredits()),
      ),
      h('div', { class: 'version' }, 'beta 0.9 — procedural build'),
    );
  }

  showLoading(text: string) {
    this.hud.style.display = 'none';
    this.layer.innerHTML = '';
    this.layer.append(h('div', { class: 'screen opaque' }, h('h2', { style: 'font-weight:normal;letter-spacing:.2em' }, text), h('div', { class: 'muted' }, 'Generating streets, houses, residents and their secrets.')));
  }

  private load(slot: string) {
    this.showLoading('Restoring your game...');
    setTimeout(async () => {
      await this.game.ensureAudio();
      const err = this.game.loadFrom(slot);
      if (err) this.showError(err);
    }, 30);
  }

  showNewGame(observer = false) {
    const seedIn = h('input', { value: randomSeed(), style: 'width:180px' }) as HTMLInputElement;
    const size = h('select', {}, h('option', { value: 'small' }, 'Small (quick)'), h('option', { value: 'medium', selected: 'selected' }, 'Medium'), h('option', { value: 'large' }, 'Large')) as HTMLSelectElement;
    size.value = 'medium';
    const dens = h('select', {}, h('option', { value: '0.5' }, 'Sparse'), h('option', { value: '0.7' }, 'Normal'), h('option', { value: '0.9' }, 'Crowded')) as HTMLSelectElement;
    dens.value = '0.7';
    const nights = h('select', {}, h('option', { value: '3' }, '3 nights (short)'), h('option', { value: '5' }, '5 nights'), h('option', { value: '7' }, '7 nights (long)')) as HTMLSelectElement;
    nights.value = '5';
    const start = async () => {
      const params: GenParams = { seed: seedIn.value.trim() || randomSeed(), size: size.value as GenParams['size'], density: parseFloat(dens.value), nights: parseInt(nights.value, 10) };
      await this.game.ensureAudio();
      if (observer) {
        this.showLoading('Building the neighbourhood...');
        setTimeout(() => this.game.startObserver(params), 30);
      } else this.game.newGame(params);
    };
    this.screen(
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, observer ? 'Observer Mode' : 'New Game'),
        observer ? h('p', { class: 'muted' }, 'Watch the neighbourhood live its life without you. Inspect residents, memories, incidents and the police at work.') : h('p', { class: 'muted' }, 'You inherit your late uncle’s house. Your uncle believed one of the neighbours was a killer. Survive the nights and find out who.'),
        h('div', { class: 'row' }, h('label', {}, 'World seed'), seedIn, btn('Random', () => (seedIn.value = randomSeed()), 'small')),
        h('div', { class: 'row' }, h('label', {}, 'Town size'), size),
        h('div', { class: 'row' }, h('label', {}, 'Population'), dens),
        observer ? null : h('div', { class: 'row' }, h('label', {}, 'Length'), nights),
        h('div', { class: 'buttons' }, btn(observer ? 'Start observing' : 'Begin', start, 'primary'), btn('Back', () => this.showMainMenu())),
      ),
    );
  }

  showSaves(saving: boolean, back?: () => void) {
    const back2 = back ?? (() => this.showMainMenu());
    const saves = listSaves();
    const rows = SLOTS.filter((s) => saving ? s !== 'auto' : true).map((slot) => {
      const meta = saves.find((s) => s.slot === slot);
      const when = meta ? new Date(meta.savedAt).toLocaleString() : '';
      return h(
        'tr',
        {},
        h('td', {}, slot === 'auto' ? 'Autosave' : `Slot ${slot.slice(4)}`),
        h('td', {}, meta ? meta.label : h('span', { class: 'muted' }, 'empty'), meta && !meta.valid ? h('div', { class: 'muted' }, meta.reason ?? '') : null),
        h('td', { class: 'muted' }, when),
        h(
          'td',
          {},
          saving
            ? btn('Save here', () => {
                const err = this.game.saveTo(slot);
                this.saveNotice = err ? `Could not save: ${err}` : 'Game saved.';
                this.showSaves(true, back);
              }, 'small')
            : btn('Load', () => this.load(slot), 'small', !meta || !meta.valid),
          ' ',
          meta ? btn('Delete', () => {
            deleteSave(slot);
            this.showSaves(saving, back);
          }, 'small danger') : null,
        ),
      );
    });
    const notice = this.saveNotice;
    this.saveNotice = '';
    this.screen(
      h(
        'div',
        { class: 'panel', style: 'min-width:620px' },
        h('h2', {}, saving ? 'Save Game' : 'Load Game'),
        notice ? h('p', { class: notice.startsWith('Could not') ? 'warn' : 'muted' }, notice) : null,
        h('table', { class: 'list' }, ...rows),
        h('div', { class: 'buttons' }, btn('Back', back2)),
      ),
    );
  }

  showPause() {
    this.hud.style.display = '';
    const g = this.game;
    this.screen(
      h('h1', { class: 'title', style: 'font-size:42px' }, 'Paused'),
      h(
        'div',
        { class: 'menu-col' },
        btn('Resume', () => g.resume(), 'primary'),
        btn('Journal', () => this.showJournal('objectives', true)),
        btn('Save Game', () => this.showSaves(true, () => this.showPause())),
        btn('Load Game', () => this.showSaves(false, () => this.showPause())),
        btn('Settings', () => this.showSettings(() => this.showPause())),
        btn('How to Play', () => this.showHelp(() => this.showPause())),
        btn('Observer Mode', () => g.startObserver()),
        btn('Quit to Main Menu', () => this.confirm('Quit to the main menu? Unsaved progress since the last autosave will be lost.', () => g.showMenuScene(), () => this.showPause())),
      ),
    );
  }

  private confirm(text: string, yes: () => void, no: () => void) {
    this.screen(h('div', { class: 'panel' }, h('p', {}, text), h('div', { class: 'buttons' }, btn('Yes', yes, 'danger'), btn('No', no))));
  }

  showSettings(back: () => void) {
    const g = this.game;
    const s = g.settings;
    const range = (label: string, key: keyof typeof s, min: number, max: number, step: number) => {
      const out = h('span', { class: 'mono muted', style: 'min-width:40px' }, String(s[key]));
      const inp = h('input', { type: 'range', min, max, step, value: s[key] }) as HTMLInputElement;
      inp.addEventListener('input', () => {
        (s as unknown as Record<string, number>)[key] = parseFloat(inp.value);
        out.textContent = inp.value;
        g.applySettings();
      });
      return h('div', { class: 'row' }, h('label', {}, label), inp, out);
    };
    const check = (label: string, key: keyof typeof s) => {
      const inp = h('input', { type: 'checkbox', checked: s[key] }) as HTMLInputElement;
      inp.addEventListener('change', () => {
        (s as unknown as Record<string, boolean>)[key] = inp.checked;
        g.applySettings();
      });
      return h('div', { class: 'row' }, h('label', {}, label), inp);
    };
    const quality = h('select', {}, h('option', { value: 'low' }, 'Low'), h('option', { value: 'medium' }, 'Medium'), h('option', { value: 'high' }, 'High')) as HTMLSelectElement;
    quality.value = s.quality;
    quality.addEventListener('change', () => {
      s.quality = quality.value as typeof s.quality;
      g.applySettings();
    });
    const binds = h('table', { class: 'list' });
    const actions = Object.keys(DEFAULT_BINDINGS) as Action[];
    const renderBinds = () => {
      binds.innerHTML = '';
      for (const a of actions) {
        const b = btn(s.bindings[a], () => {
          b.textContent = 'press a key...';
          g.input.capture = (code) => {
            // keys the browser cannot name (empty code) keep the old binding
            if (KEY_CODE.test(code)) {
              s.bindings[a] = code;
              g.applySettings();
            }
            renderBinds();
          };
        }, 'small');
        binds.append(h('tr', {}, h('td', {}, a), h('td', {}, b)));
      }
    };
    renderBinds();
    this.screen(
      h(
        'div',
        { class: 'panel', style: 'min-width:560px' },
        h('h2', {}, 'Settings'),
        h('h3', {}, 'Graphics'),
        h('div', { class: 'row' }, h('label', {}, 'Quality preset'), quality),
        range('Brightness', 'brightness', 0.6, 1.8, 0.05),
        range('Field of view', 'fov', 55, 95, 1),
        check('Post processing', 'post'),
        check('Head bob', 'headBob'),
        check('Show FPS', 'showFps'),
        h('h3', {}, 'Audio'),
        range('Master volume', 'master', 0, 1, 0.05),
        range('Music', 'music', 0, 1, 0.05),
        range('Effects', 'sfx', 0, 1, 0.05),
        range('Ambience', 'ambience', 0, 1, 0.05),
        check('3D audio (HRTF)', 'hrtf'),
        h('h3', {}, 'Controls'),
        range('Mouse sensitivity', 'sensitivity', 0.2, 3, 0.05),
        check('Invert mouse Y', 'invertY'),
        h('details', {}, h('summary', { class: 'muted', style: 'cursor:pointer;margin:8px 0' }, 'Key bindings (click to rebind)'), binds),
        h(
          'div',
          { class: 'buttons' },
          btn('Back', back, 'primary'),
          btn('Reset to defaults', () => {
            Object.assign(s, structuredClone(DEFAULT_SETTINGS));
            g.applySettings();
            this.showSettings(back);
          }),
        ),
      ),
    );
  }

  showHelp(back: () => void) {
    const k = (a: Action) => this.game.input.keyName(a);
    const rows: [string, string][] = [
      [`${k('forward')}${k('left')}${k('back')}${k('right')} / Mouse`, 'Move / look'],
      [k('sprint'), 'Sprint (uses stamina)'],
      [k('crouch'), 'Crouch / sneak (quieter, harder to see)'],
      [k('interact'), 'Interact. Hold for alternative actions (lock doors, drag bodies, pick locks, board windows)'],
      ['Left mouse', 'Attack with the equipped weapon (or fists). Breaks windows, kicks doors.'],
      ['Right mouse', 'Block'],
      [k('dodge'), 'Dodge'],
      [k('flashlight'), 'Toggle flashlight'],
      ['1-6 / Wheel / ' + k('holster'), 'Select weapon / holster'],
      [k('inventory'), 'Inventory'],
      [k('journal') + ' / ' + k('map'), 'Journal / map'],
      [k('wait'), 'Wait'],
      [k('pause'), 'Pause'],
      [k('observer'), 'Observer mode'],
    ];
    this.screen(
      h(
        'div',
        { class: 'panel', style: 'max-width:760px' },
        h('h2', {}, 'How to Play'),
        h('p', {}, 'Your late uncle believed one of your new neighbours kills at night. Everyone in town lives a real routine: they work, shop, drink, gossip and sleep. One of them goes out after midnight in a hooded coat.'),
        h('p', {}, 'By day, explore, buy supplies, introduce yourself and ask what people saw. Residents only know what they saw, heard or were told, and they tell you which. By night, lock your doors, board your windows, or go out with a flashlight and watch.'),
        h('p', {}, 'Physical traces at crime scenes, witness descriptions and your own sightings narrow down the suspects. Every resident you meet gets a profile in the journal: compare their coat, height, shoes, hair and habits with the evidence. When you are sure, accuse the culprit to the police chief. A wrong accusation costs you the chief’s trust.'),
        h('p', { class: 'muted' }, 'You win when the Night Neighbour is arrested or dead. You lose if you die, are jailed for murder, or the last night ends with the killer free.'),
        h('table', { class: 'list' }, ...rows.map(([a, b]) => h('tr', {}, h('td', { class: 'mono' }, a), h('td', {}, b)))),
        h('div', { class: 'buttons' }, btn('Back', back, 'primary')),
      ),
    );
  }

  private showCredits() {
    this.screen(
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Credits'),
        h('p', {}, 'Night Neighbour — an original procedural horror simulation.'),
        h('p', { class: 'muted' }, 'All geometry, textures, sound effects and music are generated procedurally at runtime. Built with three.js (MIT).'),
        h('div', { class: 'buttons' }, btn('Back', () => this.showMainMenu())),
      ),
    );
  }

  // ------------------------------------------------------------------ in-game dialogs

  private openPanel(kind: string, ...children: Child[]) {
    this.game.openDialog();
    this.dialogKind = kind;
    this.layer.innerHTML = '';
    const el = h('div', { class: 'screen', style: 'background:rgba(0,0,0,.35)' }, ...children);
    this.layer.append(el);
    return el;
  }

  closeDialog() {
    this.layer.innerHTML = '';
    this.dialogKind = '';
    this.game.closeDialog();
    if (this.game.arrestOfficer >= 0) this.game.resist();
  }

  showDialogue(n: NpcState, text: string, options: DialogueOption[]) {
    const sim = this.game.sim!;
    const known = sim.player.knownTo.includes(n.id);
    const sayEl = h('div', { class: 'say' }, ...text.split('\n').map((l) => h('p', {}, l)));
    this.game.openDialog();
    this.dialogKind = 'talk';
    this.layer.innerHTML = '';
    this.layer.append(
      h(
        'div',
        { class: 'panel dialog' },
        h('div', { class: 'who' }, known ? fullName(n) : 'Stranger'),
        h('div', { class: 'what' }, known ? `${JOB_TITLE[n.job]} — ${sim.world.buildings[n.homeId].address}` : n.role === 'police' ? 'A police officer' : 'A local resident'),
        sayEl,
        h('div', { class: 'options' }, ...options.map((o, i) => btn(`${i + 1}. ${o.text}`, o.action, '', o.disabled))),
      ),
    );
  }

  showText(title: string, lines: string[]) {
    this.openPanel('text', h('div', { class: 'panel', style: 'max-width:620px' }, h('h2', {}, title), ...lines.map((l) => h('p', {}, l)), h('div', { class: 'buttons' }, btn('Close', () => this.closeDialog(), 'primary'))));
  }

  showLetter(text: string) {
    this.openPanel('letter', h('div', { class: 'letter interactive' }, text), h('div', { class: 'buttons' }, btn('Fold the letter away', () => this.closeDialog(), 'primary')));
  }

  showContainer(f: Furniture) {
    const g = this.game;
    g.onOpenContainer(f);
    const render = () => {
      const sim = g.sim!;
      const inv = sim.player.inventory;
      const items = f.container ?? [];
      const left = h('div', {}, h('h3', {}, f.kind === 'fridge' ? 'Fridge' : f.kind.replace(/^\w/, (c) => c.toUpperCase())));
      if (!items.length) left.append(h('div', { class: 'muted' }, 'Empty.'));
      items.forEach((s, i) => {
        const name = s.item === 'evidence' ? sim.clues[s.tag ?? -1]?.text ?? 'Something odd' : `${itemName(s.item)}${s.n > 1 ? ' x' + s.n : ''}`;
        left.append(h('div', { class: 'item-row' }, h('span', { class: 'name' }, name), btn('Take', () => {
          g.takeFromContainer(f, i);
          render();
        }, 'small')));
      });
      const right = h('div', {}, h('h3', {}, 'Your pockets'));
      inv.forEach((s, i) => {
        right.append(h('div', { class: 'item-row' }, h('span', { class: 'name' }, `${itemName(s.item)}${s.n > 1 ? ' x' + s.n : ''}`), btn('Put', () => {
          g.putIntoContainer(f, i);
          render();
        }, 'small')));
      });
      this.openPanel('container', h('div', { class: 'panel', style: 'min-width:620px' }, h('div', { class: 'grid2' }, left, right), h('div', { class: 'buttons' }, btn('Close', () => this.closeDialog(), 'primary'))));
    };
    render();
  }

  showTrade(n: NpcState, f: Furniture) {
    const g = this.game;
    const sim = g.sim!;
    const b = sim.world.buildings[f.buildingId];
    const stock = SHOP_STOCK[b.kind] ?? [];
    const render = () => {
      const p = sim.player;
      const buy = h('div', {}, h('h3', {}, `${b.name}`));
      for (const it of stock) {
        const d = ITEMS[it];
        buy.append(h('div', { class: 'item-row' }, h('span', { class: 'name' }, d.name, h('div', { class: 'desc' }, d.desc)), h('span', { class: 'mono' }, `$${d.price}`), btn('Buy', () => {
          g.buy(it, d.price);
          render();
        }, 'small', p.money < d.price)));
      }
      const sell = h('div', {}, h('h3', {}, 'Sell valuables'));
      const vals = p.inventory.map((s, i) => ({ s, i })).filter(({ s }) => ITEMS[s.item]?.cat === 'valuable');
      if (b.kind !== 'store') sell.append(h('div', { class: 'muted' }, 'Only the general store buys valuables.'));
      else if (!vals.length) sell.append(h('div', { class: 'muted' }, 'Nothing to sell.'));
      else
        for (const { s, i } of vals) {
          const price = Math.round(ITEMS[s.item].price * 0.7);
          sell.append(h('div', { class: 'item-row' }, h('span', { class: 'name' }, `${itemName(s.item)} x${s.n}`), h('span', { class: 'mono' }, `$${price}`), btn('Sell', () => {
            g.sell(i);
            render();
          }, 'small')));
        }
      this.openPanel('trade', h('div', { class: 'panel', style: 'min-width:680px' }, h('div', { class: 'muted' }, `${fullName(n)}: "What can I get you?"  —  You have $${p.money}`), h('div', { class: 'grid2' }, buy, sell), h('div', { class: 'buttons' }, btn('Done', () => this.closeDialog(), 'primary'))));
    };
    render();
  }

  showSleep(f: Furniture) {
    const g = this.game;
    const sim = g.sim!;
    const own = f.buildingId === sim.world.playerHouseId;
    const h0 = sim.hour();
    const go = (hours: number) => {
      this.closeDialog();
      g.sleepUntil(hours);
    };
    this.openPanel(
      'sleep',
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Rest'),
        h('p', {}, own ? 'Your uncle’s old bed. The springs creak.' : 'This is not your bed. If the owners find you here...'),
        h('p', { class: 'muted' }, `It is ${formatClock(sim.time)}. Energy ${Math.round(sim.player.energy)}%. Loud noises nearby will wake you.`),
        h('div', { class: 'buttons' }, btn(h0 > 18 || h0 < 6 ? 'Sleep until morning' : 'Sleep until tomorrow morning', () => go(-1), 'primary'), btn('Nap for 2 hours', () => go(2)), btn('Cancel', () => this.closeDialog())),
      ),
    );
  }

  showWait() {
    const g = this.game;
    this.openPanel(
      'wait',
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Wait'),
        h('p', { class: 'muted' }, 'Time passes faster. Anything alarming nearby will interrupt you.'),
        h('div', { class: 'buttons' }, ...[0.5, 1, 2, 4].map((hrs) => btn(`${hrs < 1 ? '30 minutes' : hrs + ' hour' + (hrs > 1 ? 's' : '')}`, () => {
          this.closeDialog();
          g.waitHours(hrs);
        })), btn('Cancel', () => this.closeDialog())),
      ),
    );
  }

  showPhone() {
    const g = this.game;
    const show = (lines: string[]) => this.openPanel('phone', h('div', { class: 'panel' }, h('h2', {}, 'Telephone'), ...lines.map((l) => h('p', {}, l)), h('div', { class: 'buttons' }, btn('Hang up', () => this.closeDialog(), 'primary'))));
    this.openPanel(
      'phone',
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Telephone'),
        h('p', { class: 'muted' }, `You dial the ${g.world?.townName ?? ''} police.`),
        h(
          'div',
          { class: 'options', style: 'display:flex;flex-direction:column;gap:6px' },
          btn('Report a body', () => show(g.phoneReport('body'))),
          btn('Report a prowler', () => show(g.phoneReport('prowler'))),
          btn('Ask about the investigation', () => show(g.phoneReport('status'))),
          btn('Hang up', () => this.closeDialog()),
        ),
      ),
    );
  }

  showArrest(o: NpcState) {
    const g = this.game;
    this.layer.innerHTML = '';
    this.dialogKind = 'arrest';
    this.layer.append(
      h(
        'div',
        { class: 'panel dialog' },
        h('div', { class: 'who' }, `Officer ${o.last}`),
        h('div', { class: 'say' }, h('p', {}, '"You are under arrest. Do not make this harder than it needs to be."'), h('p', { class: 'muted' }, g.sim!.player.wantedLevel >= 2 ? 'Witnesses saw you kill someone.' : 'Someone reported you.')),
        h('div', { class: 'options' }, btn('Go quietly', () => g.comply(), 'primary'), btn('Run for it', () => g.resist(), 'danger')),
      ),
    );
  }

  showInventory() {
    const g = this.game;
    const render = () => {
      const sim = g.sim!;
      const p = sim.player;
      const pl = g.player!;
      const rows = p.inventory.map((s, i) => {
        const d = ITEMS[s.item];
        const equipped = p.equipped === i;
        const name = s.item === 'key' ? `Key (${sim.world.buildings[s.tag ?? -1]?.address ?? '?'})` : d?.name ?? s.item;
        const canUse = d && (d.cat === 'food' || d.cat === 'medical' || d.weapon || s.item === 'flashlight' || s.item === 'battery');
        return h(
          'div',
          { class: 'item-row' },
          h('span', { class: 'name' }, `${name}${s.n > 1 ? ' x' + s.n : ''}${equipped ? '  (equipped)' : ''}`, h('div', { class: 'desc' }, d?.desc ?? '')),
          canUse ? btn(d?.weapon ? (equipped ? 'Unequip' : 'Equip') : 'Use', () => {
            if (equipped) pl.equip(-1);
            else pl.use(i);
            render();
          }, 'small') : null,
          s.item !== 'key' ? btn('Drop', () => {
            pl.drop(i);
            render();
          }, 'small') : null,
        );
      });
      this.openPanel(
        'inventory',
        h(
          'div',
          { class: 'panel', style: 'min-width:560px' },
          h('h2', {}, 'Inventory'),
          h('div', { class: 'muted', style: 'margin-bottom:8px' }, `Money: $${p.money}   Flashlight battery: ${Math.round(p.battery)}%   Health ${Math.round(p.health)}   Hunger ${Math.round(p.hunger)}%   Energy ${Math.round(p.energy)}%`),
          ...(rows.length ? rows : [h('div', { class: 'muted' }, 'Your pockets are empty.')]),
          h('div', { class: 'buttons' }, btn('Close', () => this.closeDialog(), 'primary')),
        ),
      );
    };
    render();
  }

  showJournal(tab: string, fromPause = false) {
    this.journalTab = tab;
    const g = this.game;
    const sim = g.sim!;
    const j = g.journal!;
    const story = g.story!;
    const tabs = ['objectives', 'evidence', 'suspects', 'log', 'map'];
    const body = h('div', {});
    const close = () => (fromPause ? this.showPause() : this.closeDialog());
    switch (tab) {
      case 'objectives':
        body.append(
          h('h3', {}, 'Objectives'),
          ...story.objectives.map((o) => h('div', { class: 'item-row' }, o.text)),
          h('h3', {}, 'Situation'),
          h('p', {}, `Day ${sim.day() + 1}, ${formatClock(sim.time)}. ${story.nights - Math.max(0, sim.nightIndex() + 1)} night(s) remain.`),
          h('p', { class: 'muted' }, `Police trust: ${'●'.repeat(Math.max(0, story.trust))}${'○'.repeat(Math.max(0, 2 - story.trust))}   Clues: ${j.clues.length}   Residents met: ${[...j.residents.values()].filter((r) => r.named).length}`),
        );
        break;
      case 'evidence': {
        if (!j.clues.length) body.append(h('p', { class: 'muted' }, 'No evidence yet. Look around crime scenes and ask people what they saw.'));
        const t = h('table', { class: 'list' }, h('tr', {}, h('th', {}, 'What'), h('th', {}, 'Type'), h('th', {}, 'Source'), h('th', {}, 'Certainty')));
        for (const c of j.clues) {
          const val = c.attr === 'identity' || c.attr === 'outside' ? sim.actorName(Number(c.value)) : c.value;
          t.append(h('tr', {}, h('td', {}, c.text), h('td', {}, `${ATTR_LABEL[c.attr]}: ${val}`), h('td', { class: 'muted' }, c.source), h('td', { class: 'mono' }, `${Math.round(c.reliability * 100)}%`)));
        }
        body.append(t);
        break;
      }
      case 'suspects': {
        const known = [...j.residents.values()].filter((r) => r.named);
        if (!known.length) body.append(h('p', { class: 'muted' }, 'You have not met anyone yet.'));
        const t = h('table', { class: 'list' }, h('tr', {}, h('th', {}, 'Resident'), h('th', {}, 'Known traits'), h('th', {}, 'Against the evidence')));
        for (const r of known) {
          const n = sim.npc(r.id)!;
          const traits = [r.height && `height: ${r.height}`, r.coat && `coat: ${r.coat}`, r.hair && `hair: ${r.hair}`, r.shoes && `shoes: ${r.shoes}`, r.smoker !== undefined && (r.smoker ? 'smoker' : 'non-smoker')].filter(Boolean).join(', ');
          const fit = j.knownFit(r.id);
          t.append(
            h(
              'tr',
              {},
              h('td', { class: n.alive ? '' : 'dead' }, fullName(n), h('div', { class: 'muted' }, `${r.job ?? ''}${r.address ? ' — ' + r.address : ''}${n.inCustody ? ' (in custody)' : ''}`)),
              h('td', {}, traits || h('span', { class: 'muted' }, 'look at them in good light')),
              h('td', {}, ...fit.map((f) => h('span', { class: `tag ${f.state}` }, `${ATTR_LABEL[f.attr]} ${f.value}`))),
            ),
          );
        }
        body.append(t, h('p', { class: 'muted' }, 'Green: matches the evidence. Red: contradicts it. Grey: you do not know yet. Accuse the culprit to the police chief at the station.'));
        break;
      }
      case 'log':
        for (const l of [...j.log].reverse().slice(0, 80)) body.append(h('div', { class: 'item-row' }, h('span', { class: 'mono muted', style: 'min-width:90px' }, `D${Math.floor(l.time / 86400) + 1} ${formatClock(l.time)}`), h('span', { class: 'name' }, l.text)));
        break;
      case 'map':
        body.append(this.drawMap());
        break;
    }
    this.openPanel(
      'journal',
      h(
        'div',
        { class: 'panel', style: 'min-width:min(820px,94vw)' },
        h('h2', {}, 'Journal'),
        h('div', { class: 'tabs' }, ...tabs.map((t) => btn(t[0].toUpperCase() + t.slice(1), () => this.showJournal(t, fromPause), t === tab ? 'active small' : 'small'))),
        body,
        h('div', { class: 'buttons' }, btn('Close', close, 'primary')),
      ),
    );
  }

  private drawMap(): HTMLElement {
    const g = this.game;
    const sim = g.sim!;
    const w = sim.world;
    const S = 640;
    const sc = S / Math.max(w.width, w.depth);
    const cv = h('canvas', { width: S, height: S, class: 'map-canvas' }) as HTMLCanvasElement;
    const c = cv.getContext('2d')!;
    c.fillStyle = '#1e1c14';
    c.fillRect(0, 0, S, S);
    for (const gr of w.ground) {
      if (gr.kind === 'forestfloor') continue;
      c.fillStyle = gr.surface === 'asphalt' ? '#4a463c' : gr.kind === 'sidewalk' ? '#5e5a4e' : gr.kind === 'park' ? '#2c3a22' : gr.surface === 'gravel' ? '#3e3a30' : gr.surface === 'grass' ? '#262e1c' : '#2a261c';
      c.fillRect(gr.rect.x0 * sc, gr.rect.z0 * sc, (gr.rect.x1 - gr.rect.x0) * sc, (gr.rect.z1 - gr.rect.z0) * sc);
    }
    for (const b of w.buildings) {
      c.fillStyle = b.id === w.playerHouseId ? '#c8a45a' : b.kind === 'house' ? '#8a8270' : b.kind === 'shed' ? '#5a5448' : b.kind === 'abandoned' ? '#4a4038' : '#9a8a6a';
      c.fillRect(b.rect.x0 * sc, b.rect.z0 * sc, (b.rect.x1 - b.rect.x0) * sc, (b.rect.z1 - b.rect.z0) * sc);
    }
    // public buildings get a numbered marker and a legend entry (names would overlap on Main Street)
    const publicB = w.buildings.filter((b) => b.kind !== 'house' && b.kind !== 'shed' && b.kind !== 'abandoned').sort((a, b) => a.rect.z0 - b.rect.z0 || a.rect.x0 - b.rect.x0);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = 'bold 10px Georgia';
    publicB.forEach((b, i) => {
      const x = ((b.rect.x0 + b.rect.x1) / 2) * sc;
      const z = ((b.rect.z0 + b.rect.z1) / 2) * sc;
      c.fillStyle = '#1e1c14';
      c.beginPath();
      c.arc(x, z, 8, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#e8dcc0';
      c.fillText(String(i + 1), x, z + 0.5);
    });
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.font = '11px Georgia';
    c.fillStyle = '#e8dcc0';
    for (const l of w.landmarks) if (l.kind === 'pond' || l.kind === 'graveyard' || l.kind === 'watertower') c.fillText(l.name, l.x * sc, l.z * sc);
    // street names
    c.fillStyle = '#b8ac90';
    c.font = 'italic 10px Georgia';
    const named = new Set<string>();
    for (const r of w.roads) {
      if ((r.kind !== 'street' && r.kind !== 'main') || named.has(r.name)) continue;
      named.add(r.name);
      const x = ((r.rect.x0 + r.rect.x1) / 2) * sc;
      const z = ((r.rect.z0 + r.rect.z1) / 2) * sc;
      c.save();
      c.translate(x, z);
      if (r.axis === 'z') c.rotate(-Math.PI / 2);
      c.fillText(r.name, -30, 3);
      c.restore();
    }
    // crime scenes
    c.strokeStyle = '#d04030';
    c.lineWidth = 2;
    for (const inc of sim.incidents) {
      if (!inc.discovered || (inc.kind !== 'murder' && inc.kind !== 'breakin' && inc.kind !== 'burglary')) continue;
      const x = inc.x * sc;
      const z = inc.z * sc;
      c.beginPath();
      c.moveTo(x - 5, z - 5);
      c.lineTo(x + 5, z + 5);
      c.moveTo(x + 5, z - 5);
      c.lineTo(x - 5, z + 5);
      c.stroke();
    }
    // objective markers
    c.fillStyle = '#c8a45a';
    for (const o of g.story!.objectives) {
      if (!o.target) continue;
      c.beginPath();
      c.arc(o.target.x * sc, o.target.z * sc, 4, 0, Math.PI * 2);
      c.fill();
    }
    // player
    const p = sim.player;
    c.save();
    c.translate(p.x * sc, p.z * sc);
    c.rotate(p.yaw);
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.moveTo(0, -8);
    c.lineTo(5, 6);
    c.lineTo(-5, 6);
    c.closePath();
    c.fill();
    c.restore();
    const legend = h('ol', { class: 'map-legend' }, ...publicB.map((b) => h('li', {}, b.name)));
    return h(
      'div',
      {},
      h('div', { class: 'map-wrap' }, cv, legend),
      h('div', { class: 'muted', style: 'margin-top:6px' }, 'Gold: your house. Red crosses: crime scenes. Dots: objectives. White arrow: you.'),
    );
  }

  showEnding(e: Ending) {
    this.endingShown = true;
    const g = this.game;
    const st = g.story!.stats;
    const sim = g.sim!;
    const k = sim.npc(sim.killerId)!;
    this.hud.style.display = 'none';
    this.screen(
      h('h1', { class: 'title', style: `font-size:46px;color:${e.win ? '#e8dcc0' : '#d08070'}` }, e.title),
      h(
        'div',
        { class: 'panel', style: 'max-width:640px' },
        h('p', {}, e.text),
        h('h3', {}, 'The truth'),
        h('p', { class: 'muted' }, `The Night Neighbour was ${fullName(k)}, who ${JOB_TITLE[k.job]} and lives at ${sim.world.buildings[k.homeId].address}: ${heightClass(k.app.height)}, ${k.app.coatName} coat, ${hairName(k.app.hair)} hair, ${k.app.shoes === 'dress' ? 'dress shoes' : k.app.shoes}${k.smoker ? ', a smoker' : ''}.`),
        h('p', { class: 'muted' }, `Nights survived: ${st.nightsSurvived}. Evidence found: ${g.journal!.clues.length}. Conversations: ${st.talks}. Victims: ${sim.incidents.filter((i) => i.kind === 'murder' && i.perp === k.id).length}.`),
        h(
          'div',
          { class: 'buttons' },
          btn('New game (same town)', () => g.newGame({ ...g.params }), 'primary'),
          btn('New game (new town)', () => this.showNewGame()),
          !e.win ? btn('Load autosave', () => this.load('auto')) : null,
          btn('Main menu', () => g.showMenuScene()),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ HUD

  private buildHud() {
    const e = this.hudEls;
    e.cross = h('div', { class: 'crosshair' });
    e.prompt = h('div', { class: 'prompt' });
    e.hold = h('div', { class: 'hold-ring' });
    e.hold.innerHTML = '<svg width="46" height="46"><circle cx="23" cy="23" r="19" stroke="rgba(255,255,255,0.15)" stroke-width="3" fill="none"/><circle id="holdc" cx="23" cy="23" r="19" stroke="#c8a45a" stroke-width="3" fill="none" stroke-dasharray="119.4" stroke-dashoffset="119.4" transform="rotate(-90 23 23)"/></svg>';
    e.health = h('i', { style: 'width:100%' });
    e.stamina = h('i', { style: 'width:100%' });
    e.needs = h('div', { class: 'needs' });
    e.bars = h('div', { class: 'bars' }, h('div', { class: 'bar' }, e.health), h('div', { class: 'bar stamina small' }, e.stamina), e.needs);
    e.time = h('div', { class: 'time' });
    e.day = h('div', { class: 'day' });
    e.clock = h('div', { class: 'clock' }, e.time, e.day);
    e.compass = h('div', { class: 'compass' });
    e.objectives = h('div', { class: 'objectives' });
    e.equip = h('div', { class: 'equip' });
    e.stealth = h('div', { class: 'stealth' });
    e.messages = h('div', { class: 'messages' });
    e.vignette = h('div', { class: 'damage-vignette' });
    e.fps = h('div', { class: 'fps' });
    e.hint = h('div', { class: 'click-hint' }, 'Click to look around');
    e.name = h('div', { class: 'nameplate' });
    this.hud.append(e.vignette, e.cross, e.prompt, e.hold, e.bars, e.clock, e.compass, e.objectives, e.equip, e.stealth, e.messages, e.fps, e.hint, e.name);
  }

  updateHud() {
    const g = this.game;
    const sim = g.sim;
    if (!sim || !g.player) return;
    const p = sim.player;
    const pc = g.player;
    const e = this.hudEls;
    const now = performance.now();
    // every frame: prompt, hold ring, vignette, bubbles
    const t = pc.target;
    const showPrompt = g.mode === 'playing' && t.kind !== 'none' && !!t.prompt;
    e.prompt.style.display = showPrompt ? '' : 'none';
    if (showPrompt) {
      const html = `${escapeHtml(t.prompt)}${t.alt ? `<div class="alt">${escapeHtml(t.alt)}</div>` : ''}`;
      if (e.prompt.innerHTML !== html) e.prompt.innerHTML = html;
    }
    e.cross.className = showPrompt ? 'crosshair target' : 'crosshair';
    const holding = pc.holdAction && pc.holdNeeded > 0;
    e.hold.style.display = holding ? '' : 'none';
    if (holding) {
      const c = e.hold.querySelector('#holdc') as SVGCircleElement;
      c.setAttribute('stroke-dashoffset', String(119.4 * (1 - clamp(pc.holdT / pc.holdNeeded, 0, 1))));
    }
    e.vignette.style.opacity = String(Math.max(pc.damageFlash, p.health < 30 ? (1 - p.health / 30) * 0.6 : 0));
    e.hint.style.display = g.mode === 'playing' && !g.input.locked ? '' : 'none';
    this.updateBubbles(now);
    // messages fade
    for (const m of this.messages) {
      const age = (now - m.t) / 1000;
      m.el.style.opacity = String(age > 7 ? Math.max(0, 1 - (age - 7)) : 1);
    }
    this.hudT -= 1;
    if (this.hudT > 0) return;
    this.hudT = 6;
    // slower updates
    e.health.style.width = `${clamp(p.health, 0, 100)}%`;
    e.stamina.style.width = `${clamp(p.stamina, 0, 100)}%`;
    const hunger = p.hunger > 85 ? '<span class="warn">Starving</span>' : p.hunger > 60 ? '<span class="warn">Hungry</span>' : 'Fed';
    const energy = p.energy < 15 ? '<span class="warn">Exhausted</span>' : p.energy < 35 ? '<span class="warn">Tired</span>' : 'Rested';
    e.needs.innerHTML = `${hunger} · ${energy}${p.bleeding > 0 ? ' · <span class="warn">Bleeding</span>' : ''}${p.bloody > 0.3 ? ' · <span class="warn">Bloodstained</span>' : ''} · $${p.money}`;
    e.time.textContent = formatClock(sim.time);
    const night = sim.nightIndex();
    const h0 = sim.hour();
    e.day.textContent = `Day ${sim.day() + 1}${h0 >= 19 || h0 < 6 ? ` — night ${Math.max(1, night + 1)} of ${g.story!.nights}` : ''}`;
    // compass
    const heads: [string, number][] = [
      ['N', 0],
      ['NE', Math.PI / 4],
      ['E', Math.PI / 2],
      ['SE', (3 * Math.PI) / 4],
      ['S', Math.PI],
      ['SW', -(3 * Math.PI) / 4],
      ['W', -Math.PI / 2],
      ['NW', -Math.PI / 4],
    ];
    let html = '';
    for (const [l, a] of heads) {
      const d = wrapAngle(a - p.yaw);
      if (Math.abs(d) > 1.3) continue;
      html += `<span style="left:${50 + (d / 1.3) * 50}%">${l}</span>`;
    }
    const obj = g.story!.objectives.find((o) => o.target);
    if (obj && obj.target) {
      const a = Math.atan2(obj.target.x - p.x, -(obj.target.z - p.z));
      const d = wrapAngle(a - p.yaw);
      const dist = Math.hypot(obj.target.x - p.x, obj.target.z - p.z);
      const pos = Math.abs(d) > 1.3 ? (d > 0 ? 98 : 2) : 50 + (d / 1.3) * 50;
      html += `<span class="obj" style="left:${pos}%">▼ ${Math.round(dist)}m</span>`;
    }
    e.compass.innerHTML = html;
    e.objectives.innerHTML = g.story!.objectives.slice(0, 3).map((o) => `<div>${escapeHtml(o.text)}</div>`).join('');
    // equipment
    const slots = pc.weaponSlots();
    const eq = p.weapon ? ITEMS[p.weapon]?.name ?? p.weapon : 'Bare hands';
    e.equip.innerHTML = `<div>${escapeHtml(eq)}${p.flashlight ? ' · Flashlight' : ''}</div>${pc.count('flashlight') ? `<div class="muted" style="font-size:12px">Battery ${Math.round(p.battery)}%${pc.count('battery') ? ' (+' + pc.count('battery') + ')' : ''}</div>` : ''}<div class="slots">${slots
      .map(({ s, i }, k) => `<span class="slot ${p.equipped === i || (s.item === 'flashlight' && p.flashlight) ? 'on' : ''}">${k + 1} ${escapeHtml(itemName(s.item).split(' ').pop()!)}</span>`)
      .join('')}</div>`;
    // stealth: how visible / loud you are
    let L = sim.lightAt(p.x, p.z);
    if (p.flashlight) L = Math.max(L, 1);
    const vis = clamp(L * (p.crouching ? 0.55 : 1) * (p.stance === 'hidden' ? 0 : 1), 0, 1);
    const col = vis > 0.6 ? '#f0e0b0' : vis > 0.25 ? '#a09070' : '#4a4438';
    e.stealth.innerHTML = `<span style="color:${col}"><i class="eye"></i> ${p.stance === 'hidden' ? 'hidden' : vis > 0.6 ? 'exposed' : vis > 0.25 ? 'visible' : 'in shadow'}</span><span>noise ${'█'.repeat(Math.min(5, Math.round(p.noise / 3)))}${'░'.repeat(Math.max(0, 5 - Math.round(p.noise / 3)))}</span>${p.wantedLevel ? `<span style="color:#e07060">${p.wantedLevel >= 2 ? 'WANTED FOR MURDER' : 'wanted'}</span>` : ''}`;
    e.fps.textContent = g.settings.showFps ? `${Math.round(g.fps)} fps  ${g.renderer.stats.calls} calls  ${Math.round(g.renderer.stats.tris / 1000)}k tris` : '';
  }

  private updateBubbles(now: number) {
    const g = this.game;
    const sim = g.sim!;
    const cam = g.renderer.camera;
    const v = new THREE.Vector3();
    for (const [id, b] of this.bubbles) {
      const a = sim.actors[id];
      if (!a || now > b.until) {
        b.el.remove();
        this.bubbles.delete(id);
        continue;
      }
      v.set(a.x, a.y + 2.15, a.z).project(cam);
      const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      b.el.style.display = visible ? '' : 'none';
      if (visible) {
        b.el.style.left = `${((v.x + 1) / 2) * 100}%`;
        b.el.style.top = `${((1 - v.y) / 2) * 100}%`;
      }
    }
    // name over the targeted resident
    const t = g.player!.target;
    const e = this.hudEls.name;
    if (t.kind === 'npc') {
      const a = sim.actors[t.id];
      v.set(a.x, a.y + 2.0, a.z).project(cam);
      const n = sim.npc(t.id);
      e.textContent = n && sim.player.knownTo.includes(n.id) ? fullName(n) : '';
      e.style.left = `${((v.x + 1) / 2) * 100}%`;
      e.style.top = `${((1 - v.y) / 2) * 100}%`;
      e.style.display = '';
    } else e.style.display = 'none';
  }

  // ------------------------------------------------------------------ observer

  showObserver() {
    const g = this.game;
    const ob = g.observer!;
    const sim = g.sim!;
    this.hud.style.display = 'none';
    this.obsEl?.remove();
    const clock = h('span', {});
    const speeds: [number, string][] = [
      [0, '⏸'],
      [1, '1x'],
      [4, '4x'],
      [16, '16x'],
      [60, '60x'],
    ];
    const speedBtns = speeds.map(([v, label]) => {
      const b = btn(label, () => {
        ob.speed = v;
        this.obsT = 0;
      }, 'small');
      b.dataset.speed = String(v);
      return b;
    });
    const toggle = (name: 'showPaths' | 'showSight' | 'showNav', label: string) => {
      const b = btn(label, () => {
        ob[name] = !ob[name];
        this.obsT = 0;
      }, 'small');
      b.dataset.toggle = name;
      b.dataset.base = label;
      return b;
    };
    const toggles = [toggle('showPaths', 'paths'), toggle('showSight', 'sight'), toggle('showNav', 'nav')];
    const top = h(
      'div',
      { class: 'obs-top' },
      clock,
      ...speedBtns,
      ...toggles,
      btn('Exit', () => g.exitObserver(), 'small danger'),
      h('span', { class: 'muted' }, 'Click the view, then WASD/Space/C to fly, Shift = fast'),
    );
    const detail = h('div', {});
    const incidents = h('div', {});
    const cases = h('div', {});
    const list = h('div', {});
    const rows = new Map<number, HTMLElement>();
    for (const n of sim.npcs) {
      const row = h('div', {
        class: 'res',
        onpointerdown: () => {
          ob.select(n.id);
          ob.follow = true;
          this.obsT = 0;
        },
      });
      rows.set(n.id, row);
      list.append(row);
    }
    this.obsEl = h('div', {}, top, h('div', { class: 'obs-panel' }, detail, incidents, cases, h('h3', {}, 'Residents'), list));
    this.obsParts = { clock, speedBtns, toggles, detail, incidents, cases, rows };
    this.root.append(this.obsEl);
    this.obsT = 0;
  }

  private obsParts: {
    clock: HTMLElement;
    speedBtns: HTMLElement[];
    toggles: HTMLElement[];
    detail: HTMLElement;
    incidents: HTMLElement;
    cases: HTMLElement;
    rows: Map<number, HTMLElement>;
  } | null = null;

  /** refresh the observer panel in place (no rebuild, so clicks are never lost) */
  updateObserver() {
    const g = this.game;
    const ob = g.observer;
    const parts = this.obsParts;
    if (!ob || !this.obsEl || !parts) return;
    this.obsT -= 1;
    if (this.obsT > 0) return;
    this.obsT = 10;
    const sim = g.sim!;
    parts.clock.textContent = `Day ${sim.day() + 1} ${formatClock(sim.time)}`;
    for (const b of parts.speedBtns) b.className = `small${Number(b.dataset.speed) === ob.speed ? ' primary' : ''}`;
    for (const b of parts.toggles) {
      const on = ob[b.dataset.toggle as 'showPaths'];
      b.textContent = `${b.dataset.base} ${on ? 'on' : 'off'}`;
      b.className = `small${on ? ' primary' : ''}`;
    }
    for (const n of sim.npcs) {
      const row = parts.rows.get(n.id);
      if (!row) continue;
      row.className = `res ${n.id === ob.selected ? 'sel' : ''} ${n.alive ? '' : 'dead'} role-${n.role}`;
      const text = `${fullName(n).padEnd(20)} ${n.alive ? (n.inCustody ? 'in custody' : n.activity?.kind ?? '-') : n.missing ? 'missing (dead)' : 'dead'}${n.sleeping ? ' zz' : ''}${n.alarm > 0.3 ? ' !' : ''}`;
      if (row.textContent !== text) row.textContent = text;
    }
    const sel = ob.selected >= 0 ? sim.npc(ob.selected) : null;
    parts.detail.innerHTML = '';
    if (sel) {
      const mem = [...sel.memories].sort((a, b) => b.time - a.time).slice(0, 8);
      parts.detail.append(
        h('h3', {}, fullName(sel)),
        h('div', {}, `${sel.role.toUpperCase()} — ${sel.job}, age ${sel.age}`),
        h('div', {}, `home ${sim.world.buildings[sel.homeId].address}${sel.workId >= 0 ? ', works at ' + sim.world.buildings[sel.workId].name : ''}`),
        h('div', {}, `Needs: health ${Math.round(sel.health)}  hunger ${Math.round(sel.needs.hunger)}  energy ${Math.round(sel.needs.energy)}  social ${Math.round(sel.needs.social)}  fear ${Math.round(sel.needs.fear)}  alarm ${sel.alarm.toFixed(2)}  $${sel.money}`),
        h('div', {}, `Activity: ${sel.activity?.kind ?? '-'} (prio ${sel.activity?.priority ?? 0})${sel.ctl.hs ? ' / hunt:' + sel.ctl.hs : ''}${sel.ctl.bs ? ' / burgle:' + sel.ctl.bs : ''}`),
        h('div', {}, `tasks: ${sel.tasks.map((t) => t.kind).join(' > ') || '-'}`),
        h('div', {}, `destination: ${sel.pathGoal ? `${sel.pathGoal.x.toFixed(0)},${sel.pathGoal.z.toFixed(0)} (${sim.placeName(sel.pathGoal.x, sel.pathGoal.z)})` : '-'}`),
        h('div', {}, `traits: brave ${sel.traits.bravery.toFixed(2)} curious ${sel.traits.curiosity.toFixed(2)} aggressive ${sel.traits.aggression.toFixed(2)} vigilant ${sel.traits.vigilance.toFixed(2)}`),
        h('div', {}, `looks: ${heightClass(sel.app.height)}, ${sel.app.coatName} coat, ${hairName(sel.app.hair)} ${sel.app.hairStyle}, ${sel.app.shoes}${sel.smoker ? ', smoker' : ''}`),
        h('h3', {}, `Memories (${sel.memories.length})`),
        ...mem.map((m) => h('div', {}, `[${m.source}] ${memoryLine(sim, sel, m)}`)),
      );
    } else parts.detail.append(h('div', { class: 'muted' }, 'Select a resident to inspect.'));
    parts.incidents.innerHTML = '';
    parts.incidents.append(h('h3', {}, 'Incidents'), ...sim.incidents.slice(-8).map((i) => h('div', {}, `${formatClock(i.time)} ${i.kind} by ${sim.actorName(i.perp)}${i.victim >= 0 ? ' on ' + sim.actorName(i.victim) : ''} ${i.discovered ? '(known)' : '(undiscovered)'}`)));
    parts.cases.innerHTML = '';
    parts.cases.append(h('h3', {}, 'Police cases'), ...sim.cases.slice(-8).map((c) => h('div', {}, `#${c.id} ${c.kind} — ${c.status}${c.assigned >= 0 ? ', ' + sim.actorName(c.assigned) : ''}${c.suspect >= 0 ? ', suspect ' + sim.actorName(c.suspect) : ''} (${c.reports.length} reports)`)));
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function randomSeed() {
  const words = ['ash', 'crow', 'elm', 'hollow', 'lantern', 'moth', 'raven', 'cellar', 'hush', 'thorn', 'quiet', 'ember'];
  return `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(Math.random() * 9000 + 1000)}`;
}

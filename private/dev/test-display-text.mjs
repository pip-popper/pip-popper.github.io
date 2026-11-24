// node private/dev/test-display-text.mjs — the display-only clean-up of "AIの感想" texts.
import assert from 'node:assert/strict';
import { displayText } from '../worker/src/display-text.js';

const t = (input, expected, name) => { assert.equal(displayText(input), expected, name); console.log('OK ', name); };
t('### AIの感想｜曲名\n\n本文1\n\n本文2', '本文1\n\n本文2', '先頭の見出し行と直後の空行は表示しない');
t('本文\n## 小見出し\n続き', '本文\n小見出し\n続き', '途中の見出し記号は外して文字は残す');
t('前の文\n**強調の一文。**\n後の文', '前の文\n強調の一文。\n後の文', '太字記号は外して文字は残す');
t('普通の感想。\n\n改行も空行もそのまま。', '普通の感想。\n\n改行も空行もそのまま。', 'Markdownのない文は一字も変えない');
t('#5の曲と ** だけの行', '#5の曲と ** だけの行', '見出しでない # や対になっていない ** は残す');
t('### 見出しだけ', '', '見出しだけの文は空になる');
assert.equal(displayText(null), null); assert.equal(displayText(''), ''); console.log('OK  空・null はそのまま');
console.log('すべて合格');

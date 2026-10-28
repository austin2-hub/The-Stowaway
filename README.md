# The Stowaway

A 3–8 player bluffing word game aboard a rainy night ferry. Every passenger holds the same destination word except one stowaway, who holds a near match and doesn't know it. Place lanterns on the Night Chart, spot whose lantern drifts from the pack, talk it over, vote the stowaway ashore. If caught, the stowaway gets one last guess at the real word.

## Run locally

Requires Node.js 18 or newer. No packages to install.

```sh
npm start
```

Open `http://localhost:3001`. Other devices on your network can board with the four-letter ticket number, or tap **Practice** to play alone with two bots.

## Rules

| Phase | Time | What happens |
|---|---|---|
| Tickets | 8s | Hold to reveal your secret destination |
| Night Chart 1 | 30s | The captain draws two scales (e.g. Cheap ↔ Pricey, Everyday ↔ Special occasion). Everyone secretly taps where their destination belongs and lights their lantern. Ends early when all are lit |
| Lanterns lit | 8s | Every lantern appears at once, so nobody can copy. Whose sits apart? |
| Night Chart 2 | 30s + 8s | Two new scales. A stowaway who saw their lantern drift can try to blend in |
| Discuss | 45s | Talk out loud or on a call with both charts on screen. Pin a suspect to make their lanterns glow. Voting opens early when everyone is ready |
| Vote | 20s | Votes can be changed until the bell. When every vote is in, the ferry docks in 3 seconds |
| Reveal | 9s | The single most-voted passenger is put ashore. A tie puts nobody ashore |
| Last guess | 15s | Only if the stowaway was caught. The group word stays hidden from them until they guess |

Scoring: +100 to each passenger who voted for the stowaway, +200 to a stowaway who escapes, +100 to a caught stowaway who guesses the group word.

## Included

- Server-authoritative timers, turn order, votes and scores. The stowaway's identity and the group word never reach a client before the reveal
- Food, Places, Movies, Everyday Objects and Mixed packs (25 hand-checked pairs each), 3/5/7 rounds
- **The Night Chart**: every destination word is rated on six common scales and two per pack (`chart.json`, kept private). Each chart pairs the scale that best splits the round's two words with a random one, so the stowaway's lantern tends to drift but can blend in
- Tap or arrow-key placement, lanterns that light together, names that dodge each other, and both charts carried into the discussion, vote, reveal and last guess
- Practice mode and lobby bots that place lanterns from the ratings (a stowaway bot sometimes blends in on chart 2), suspect whoever drifted most, vote and guess
- Reconnect with a private session token, host handover after 15 seconds, round voided if the stowaway leaves, pause under three passengers
- Hold-to-reveal ticket, porthole timer, rubber-stamp reveal, synthesised ferry horn and sounds, haptics, 3-card how-to carousel, screen-reader announcements, reduced motion
- Only `index.html`, `client.js`, `fx.js` and `style.css` are served; `/healthz` returns `ok` for uptime monitors
- Gamified layer (`fx.js`): passenger ranks from Deckhand to Admiral of the Night, XP and eight passport stamps saved on the device, crossing bumpers, typewriter verdicts, vote tokens dropping onto the tally, luggage-tag avatars, rank arrows, a podium and a shareable result card

Rooms and scores are held in memory and reset when the server restarts.

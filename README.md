# Collective Memory × GenLayer — Photo-Verification Payment Escrow

A working **Internet Court** demo for GenLayer Mission 101
("Internet Court: Partner Demo Lab").

**Partner: Collective Memory** — a member of the Internet Court consortium.
**Use case: photo-verification payment.** A requester posts a photo task
("show me the Eiffel Tower lit up at night"), locks GEN in escrow, and a
contributor submits a photo. A GenLayer **Intelligent Contract** judges
whether the photo matches the task — and the verdict is *enforced* by the
escrow: match → the contributor is paid; mismatch → the requester is
refunded. No human moderator, no trusted third party.

## Why this needs GenLayer (not a plain smart contract)

The question "does this photo show what was asked for?" is subjective and
needs live web data. Rigid code cannot answer it. This contract can,
because GenLayer gives it three things a normal chain cannot:

1. **Web access** — the judge fetches the submitted photo page
   (`gl.get_webpage`) instead of trusting a URL string.
2. **LLM judging** — an on-chain LLM call (`gl.nondet.exec_prompt`)
   evaluates the photo against the acceptance criteria.
3. **Validator consensus** — every validator re-runs the verdict and only
   the boolean has to agree (`gl.vm.run_nondet_unsafe`, the same
   leader/validator pattern as GenLayer's own Wizard of Coin). The verdict
   is decided by Optimistic Democracy, then settled on-chain.

The escrow makes the verdict real: payment moves if and only if the jury
says so. GenLayer is the adjudicator, not decoration.

## Live deployment

| Item | Value |
|---|---|
| Chain | **GenLayer Studio Next** (Studio Devnet), chain id **61997** |
| RPC | `https://studio-dev.genlayer.com/api` |
| Explorer | `https://explorer-studio-dev.genlayer.com` |
| Contract | `0x4A7a84C12495550AE81c97BDb65bEb14f4ddFaBF` |
| Deploy tx | `0x8ea16df8a391d0c61159af314036bd92e5530420044eba80e4a3e8a0e0734ff3` |
| Deployer (fresh test account) | `0x691bbbe4a22b4cfacb6e713bfc89358ae8f1000a` |
| genlayer-js | 2.0.0 · py-genlayer pin `1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6` |

Contract source: [`contracts/photo_task_escrow.py`](contracts/photo_task_escrow.py)
(the exact code deployed on-chain — verify with
`genlayer code 0x4A7a84C12495550AE81c97BDb65bEb14f4ddFaBF`).

## Demo deals (run end-to-end on-chain)

Both deals use the same criteria — *"The photo must clearly show the
Eiffel Tower illuminated at night"* — and a 1 GEN escrow.

### Deal A — match → payment released ✅

| Step | Tx |
|---|---|
| `create_task("eiffel-night", …)` — requester locks 1 GEN | [`0x1df6bffc…`](https://explorer-studio-dev.genlayer.com/tx/0x1df6bffcbee071104e6fa3d1c4bf9a748b137b9d52bb8a7ad851c91b096d092a) |
| `submit_photo(… Eiffel_Tower_at_night.jpg)` — contributor | [`0xebe025c1…`](https://explorer-studio-dev.genlayer.com/tx/0xebe025c1480a03820d4d0f34af7ed37490bdc52ab0279534272110f5b0d4b9b0) |
| `judge("eiffel-night")` | [`0x1f0a43ab…`](https://explorer-studio-dev.genlayer.com/tx/0x1f0a43ab29183c98d3f14e65cd42e5407c76fe0371dbdaea715bd2102f6023cb) |

**Verdict: `released`, `match=true`.**
Reasoning (on-chain): *"Judging from the URL filename
'Eiffel_Tower_at_night.jpg' and the contributor's description of the tower
fully illuminated against a dark sky, the submission matches. The page
could not be fetched, so visual verification was not possible."*
After finalization: contributor 100.9998 → 101.9998 GEN (+1 GEN),
contract balance 0 GEN.

### Deal B — mismatch → refund ✅

| Step | Tx |
|---|---|
| `create_task("eiffel-night-2", …)` — requester locks 1 GEN | [`0xb2088ce2…`](https://explorer-studio-dev.genlayer.com/tx/0xb2088ce278ddbdf44c466111c003f4551d5f342ef4825a07c7eb3594d5e0c09f) |
| `submit_photo(… Colosseum_in_Rome,_Italy_-_April_2007.jpg)` — contributor | [`0x12c07516…`](https://explorer-studio-dev.genlayer.com/tx/0x12c07516220881101c6527edcae95fe95616afb041cb1cc8a1f3d273138199b6) |
| `judge("eiffel-night-2")` | [`0x60f3842f…`](https://explorer-studio-dev.genlayer.com/tx/0x60f3842f1b587add31f6bfe5c5b0a715f805f11bb894293a8b1e0d23aef49260) |

**Verdict: `refunded`, `match=false`.**
Reasoning (on-chain): *"The page could not be fetched, so I judged from
the URL filename and the contributor description. Both say this is a
daytime photo of the Colosseum in Rome, not the Eiffel Tower illuminated
at night. It does not meet the criteria."*
After finalization: requester 97.9994 → 97.9992 GEN net (fees only —
the 1 GEN escrow was refunded in full), contract balance 0 GEN.

Demo actors (fresh test keys, funded with test GEN via `sim_fundAccount`):

- requester `0x97fBa78F4778A3185A9904177642c561ce3086E8`
- contributor `0x9426f117b3470E094C50bf10708F8E522d6D15f8`

## How the contract works

`contracts/photo_task_escrow.py` — `PhotoTaskEscrow`:

- `create_task(task_id, description, criteria)` **payable** — locks
  `msg.value` as the escrow reward. One task per id.
- `submit_photo(task_id, photo_url, photo_description)` — contributor
  attaches the photo URL and a short description.
- `judge(task_id)` — anyone may call once evidence is in. Runs
  `_judge_photo`: fetch the photo page as text, prompt the LLM for
  `{"match": bool, "reasoning": str ≤ 280 chars}`, validators agree on
  the boolean. Match → pay the contributor; mismatch → refund the
  requester. The verdict and reasoning are stored on-chain in the task.
- `claim()` — pull-payment fallback (see below).
- Views: `get_task`, `get_task_count`, `get_claimable`, `get_balance`.

**Fail-closed judging.** Unparseable model output counts as *no match*,
so a flaky jury can never release the escrow by accident. Only the
`match` boolean needs validator agreement; the leader's wording is kept.

**Payments.** Payouts use an external message
(`_Recipient(...).emit_transfer(...)`) to the winner's EOA. If that
transfer cannot be emitted, the amount is credited to an on-chain
claimable balance and the winner pulls it with `claim()` — funds are
never silently lost. One Studio quirk, verified live: an EOA payout
settles when the judge transaction **finalizes**, not when it is
decided — balances read immediately after decision may still show the
old value. The demo script waits for finalization before reporting
balances.

**Judging honesty.** The judge tries `gl.get_webpage(url, mode="text")`
first and includes the fetched text in the prompt; if the fetch yields
no usable text it says so in its reasoning and falls back to the URL
(filename/path) plus the contributor's description. In both demo deals
the fetch failed inside GenVM and the jury said so explicitly in its
reasoning ("The page could not be fetched…"), then decided from the
filename/URL and the contributor description. The verdicts were correct
in both deals, and the stored reasoning shows exactly which evidence the
jury used. A future improvement is to point the judge at directly
fetchable image hosts (e.g. raw image bytes) instead of Wikimedia file
pages.

## Run it yourself

Prerequisites: Node 20+, `npm install -g genlayer` (CLI 0.40.0), and
test GEN on Studio Next (the Studio faucet / `sim_fundAccount` — no
mainnet ETH needed).

```bash
git clone https://github.com/gmrekt/collective-memory-photo-escrow.git && cd collective-memory-photo-escrow
npm install

# 1. Deploy your own copy (fresh CLI account, funded with test GEN)
genlayer account create demo-lab          # or reuse an existing one
genlayer network select studio-dev
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"sim_fundAccount",
       "params":["<YOUR_ADDRESS>","0x56bc75e2d63100000"]}' \
  https://studio-dev.genlayer.com/api     # 100 GEN
FEES=$(genlayer estimate-fees --json)     # full fee profile (required:
                                          # bare --fee-value is rejected
                                          # with FeeValueMustBeNonZero)
genlayer deploy --contract contracts/photo_task_escrow.py --fees "$FEES"
# note the Contract Address, then:
echo "<CONTRACT_ADDRESS>" > .contract-address

# 2. Run both demo deals end-to-end
npm run demo            # or: node scripts/demo.mjs [A|B]
```

`scripts/demo.mjs` creates two fresh actor accounts (requester +
contributor), funds each with 100 test GEN, and runs Deal A (match →
release) and Deal B (mismatch → refund), printing every tx hash,
explorer link, verdict, reasoning, and before/after balances. Actor
keys are saved to `.env` (mode 0600, gitignored) and reused on later
runs; already-completed deals are detected on-chain and resumed, not
re-created. Test GEN only — never point this at mainnet.

## Notes for reviewers

- **No mocks.** The contract is deployed on Studio Next (61997), the
  demo deals ran against it on-chain, and the verdicts + payment
  movements are visible on the explorer links above.
- **Original code.** Written for this mission; the only borrowed pattern
  is GenLayer's own Wizard-of-Coin leader/validator shape
  (`gl.nondet.exec_prompt` + `gl.vm.run_nondet_unsafe`), which is the
  proven jury pattern on this network.
- **Known Studio Next quirks (all hit live, all worked around):**
  - Deploys/writes need the *full* fee profile from `estimate-fees`
    (distribution + `feeValue`); `--fee-value` alone reverts with
    `FeeValueMustBeNonZero`.
  - The contract must pin a real py-genlayer version
    (`1jb45aa8…`); the template's `py-genlayer:test` fails to load on
    Studio Next.
  - `genlayer-js` 0.9.5 speaks the old (pre-fees) consensus ABI and
    cannot write to this network; **2.0.0** is required.
  - EOA payouts settle at finalization, not decision.
  - `genlayer trace` (`gen_dbg_traceTransaction`) is not available on
    Studio Next; use the explorer + `get_task` reads instead.
  - Studio Next's RPC is capacity-limited and sometimes answers
    `Server busy: all 8 execution slots occupied` (code -32006) — the
    demo script retries those reads/estimates with backoff.
- **Demo video:** [`demo-video.mp4`](demo-video.mp4) (41 seconds, in this repo).
  this repo is the code + the on-chain proof.

# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
PhotoTaskEscrow — Collective Memory x GenLayer Internet Court demo.

Use case: photo-verification payment.
  1. A requester (here: Collective Memory, a member of the Internet Court
     consortium) creates a photo task with a description, acceptance
     criteria, and a GEN payment held in escrow.
  2. A contributor submits a photo URL plus a short description of the photo.
  3. A GenLayer Intelligent Contract adjudicates: it fetches the submitted
     photo page from the web, asks an LLM whether the photo matches the
     task criteria, and GenLayer validators reach consensus on the verdict
     under the Equivalence Principle. The verdict is then *enforced* by the
     escrow — payment is released to the contributor on a match, or
     refunded to the requester on a mismatch.

This is the Internet Court pattern in miniature: a real-world, subjective
question ("does this photo show what was asked for?") that rigid code
cannot answer, decided by a decentralised jury of AI validators and
settled on-chain. GenLayer is not decorative here — without its
web access, LLM judging, and validator consensus there is no verdict,
and without the verdict there is no payment.

Payment mechanics (see docs.genlayer.com "Value Transfers"):
  * `create_task` is payable: the requester locks GEN in the contract.
  * On verdict, the escrow is paid out with an external message
    (`_Recipient(...).emit_transfer(...)`) to the winner's EOA.
  * If that external transfer cannot be emitted (e.g. Studio has no EVM
    layer), the amount is credited to an on-chain claimable balance
    instead and the winner can pull it later with `claim()`. Funds are
    never silently lost.

Judging honesty note: the judge fetches the submitted URL with
`gl.get_webpage(..., mode="text")` and includes the fetched text in the
LLM prompt. If a fetch returns no usable text, the judge says so in its
reasoning and falls back to the URL itself (filename/path) plus the
contributor's description. In the two demo deals the jury's reasoning
cites the photo filename/URL and the contributor description, which is
consistent with the fallback path (the Commons file-page fetch did not
yield usable text inside GenVM). The verdict JSON and the reasoning are
stored on-chain with every task, so anyone can audit what the jury saw
and which evidence it cited.
"""

import json
from dataclasses import dataclass

from genlayer import *


@gl.evm.contract_interface
class _Recipient:
    """Minimal EVM interface used to pay GEN out to an EOA (external message)."""

    class View:
        pass

    class Write:
        pass


@allow_storage
@dataclass
class PhotoTask:
    id: str
    requester: str  # hex address of the task creator
    description: str  # what photo is wanted
    criteria: str  # acceptance criteria the photo is judged against
    reward: u256  # GEN escrowed for this task, in wei
    status: str  # "open" | "submitted" | "released" | "refunded"
    photo_url: str
    photo_description: str
    contributor: str  # hex address of the contributor, "" until submitted
    match: bool  # verdict: True when the photo matches the criteria
    reasoning: str  # the jury's reasoning, stored on-chain


class PhotoTaskEscrow(gl.Contract):
    tasks: TreeMap[str, PhotoTask]
    claimable: TreeMap[str, u256]  # pull-payment fallback, keyed by hex address
    task_count: u256

    def __init__(self):
        self.task_count = u256(0)

    # -- internal helpers -------------------------------------------------

    def _pay(self, recipient: str, amount: u256) -> None:
        """Pay `amount` wei to an EOA, or credit it as claimable on failure."""
        if amount == u256(0):
            return
        try:
            _Recipient(Address(recipient)).emit_transfer(value=amount)
        except Exception:
            current = self.claimable.get(recipient, u256(0))
            self.claimable[recipient] = current + amount

    def _judge_photo(self, task: PhotoTask) -> dict:
        """Ask the validator jury whether the submitted photo matches.

        Follows the deployed WizardOfCoin pattern: a leader function runs
        the LLM verdict (web fetch + prompt) and each validator re-runs
        it; only the `match` boolean has to agree across validators
        (Optimistic Democracy / Equivalence Principle). The verdict is
        fail-closed: unparseable model output counts as NO match, so a
        flaky jury can never release the escrow by accident.
        Returns {"match": bool, "reasoning": str}.
        """

        def _verdict(raw) -> dict:
            try:
                data = json.loads(raw) if isinstance(raw, str) else raw
            except (ValueError, TypeError):
                data = None
            if not isinstance(data, dict):
                return {"match": False, "reasoning": "judge output was unparseable"}
            reasoning = data.get("reasoning")
            reasoning = (
                reasoning.strip()[:280] if isinstance(reasoning, str) else ""
            )
            return {"match": data.get("match") is True, "reasoning": reasoning}

        def _valid_verdict(v) -> bool:
            return (
                isinstance(v, dict)
                and set(v) == {"match", "reasoning"}
                and isinstance(v["match"], bool)
                and isinstance(v["reasoning"], str)
                and len(v["reasoning"]) <= 280
            )

        def leader_fn() -> dict:
            try:
                page_text = gl.get_webpage(task.photo_url, mode="text")
            except Exception:
                page_text = ""
            page_text = (page_text or "")[:4000]
            if page_text.strip():
                evidence = (
                    "Fetched content of the submitted photo page:\n" + page_text
                )
            else:
                evidence = (
                    "The submitted photo page could not be fetched as text. "
                    "Judge from the photo URL itself (its filename and path) "
                    "and from the contributor description below, and say so "
                    "in your reasoning."
                )
            prompt = f"""
You are the judge of the Internet Court for a photo-verification task.

Task description: {task.description}
Acceptance criteria: {task.criteria}

Submitted photo URL: {task.photo_url}
Contributor description of the photo: {task.photo_description}

{evidence}

Decide whether the submitted photo satisfies the acceptance criteria.
Be strict: the photo must clearly show what the criteria ask for. A
different subject, a wrong place, or a photo that does not show the
criteria at all is NOT a match.

Respond using ONLY the following JSON format, nothing else:
{{
    "match": bool, // true only if the photo clearly satisfies the criteria
    "reasoning": str // at most 280 characters, plain text
}}
It is mandatory that you respond only using the JSON format above,
nothing else. Don't include any other words or characters, your output
must be only JSON without any formatting prefix or suffix. This result
should be perfectly parsable by a JSON parser without errors.
"""
            try:
                raw = gl.nondet.exec_prompt(prompt, response_format="json")
            except ValueError:
                raw = None
            return _verdict(raw)

        def validator_fn(leaders_res: gl.vm.Result) -> bool:
            if not isinstance(
                leaders_res, gl.vm.Return
            ) or not _valid_verdict(leaders_res.calldata):
                return False
            # Each validator decides on its own; only the boolean must
            # match, the wording is the leader's.
            return leader_fn()["match"] == leaders_res.calldata["match"]

        verdict = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
        if not _valid_verdict(verdict):
            raise gl.vm.UserError("[LLM_ERROR] invalid consensus verdict")
        return verdict

    # -- public writes ----------------------------------------------------

    @gl.public.write.payable
    def create_task(self, task_id: str, description: str, criteria: str) -> None:
        """Create a photo task, locking `gl.message.value` GEN in escrow."""
        if gl.message.value == u256(0):
            raise gl.vm.UserError("escrow must be greater than 0 GEN")
        if task_id in self.tasks:
            raise gl.vm.UserError("task id already exists")
        self.tasks[task_id] = PhotoTask(
            id=task_id,
            requester=gl.message.sender_address.as_hex,
            description=description,
            criteria=criteria,
            reward=gl.message.value,
            status="open",
            photo_url="",
            photo_description="",
            contributor="",
            match=False,
            reasoning="",
        )
        self.task_count = self.task_count + u256(1)

    @gl.public.write
    def submit_photo(
        self, task_id: str, photo_url: str, photo_description: str
    ) -> None:
        """Submit a photo as evidence for an open task."""
        if task_id not in self.tasks:
            raise gl.vm.UserError("unknown task")
        task = self.tasks[task_id]
        if task.status != "open":
            raise gl.vm.UserError("task is not open for submissions")
        task.photo_url = photo_url
        task.photo_description = photo_description
        task.contributor = gl.message.sender_address.as_hex
        task.status = "submitted"
        self.tasks[task_id] = task

    @gl.public.write
    def judge(self, task_id: str) -> None:
        """Adjudicate a submitted task and enforce the verdict.

        Anyone may call this once evidence is in — like asking the court
        to rule. A match releases the escrow to the contributor; a
        mismatch refunds it to the requester.
        """
        if task_id not in self.tasks:
            raise gl.vm.UserError("unknown task")
        task = self.tasks[task_id]
        if task.status != "submitted":
            raise gl.vm.UserError("task has no submission waiting for a verdict")
        verdict = self._judge_photo(task)
        task.match = bool(verdict["match"])
        task.reasoning = str(verdict["reasoning"])[:280]
        if task.match:
            task.status = "released"
            self.tasks[task_id] = task
            self._pay(task.contributor, task.reward)
        else:
            task.status = "refunded"
            self.tasks[task_id] = task
            self._pay(task.requester, task.reward)

    @gl.public.write
    def claim(self) -> None:
        """Pull a claimable balance credited when a direct payout failed."""
        sender = gl.message.sender_address.as_hex
        amount = self.claimable.get(sender, u256(0))
        if amount == u256(0):
            raise gl.vm.UserError("nothing to claim")
        self.claimable[sender] = u256(0)
        _Recipient(Address(sender)).emit_transfer(value=amount)

    # -- public views -----------------------------------------------------

    @gl.public.view
    def get_task(self, task_id: str) -> dict:
        if task_id not in self.tasks:
            raise gl.vm.UserError("unknown task")
        task = self.tasks[task_id]
        return {
            "id": task.id,
            "requester": task.requester,
            "description": task.description,
            "criteria": task.criteria,
            "reward_wei": str(task.reward),
            "status": task.status,
            "photo_url": task.photo_url,
            "photo_description": task.photo_description,
            "contributor": task.contributor,
            "match": task.match,
            "reasoning": task.reasoning,
        }

    @gl.public.view
    def get_task_count(self) -> int:
        return int(self.task_count)

    @gl.public.view
    def get_claimable(self, account: str) -> str:
        return str(self.claimable.get(account, u256(0)))

    @gl.public.view
    def get_balance(self) -> str:
        return str(self.balance)

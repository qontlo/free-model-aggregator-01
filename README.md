# free-model-aggregator-01

One server, two client wires (OpenAI + Anthropic), ten simulated providers.

The server reads the trial brief, probes every provider's own catalog route, registers the catalog with the environment, then answers the environment client's 20 requests one at a time. Each request is served by the highest-rated free model that meets its requirements, dialled in that provider's own wire (OpenAI, Anthropic or Gemini); a refusal fails over to the next candidate immediately. The provider's answer text, stop reason and usage counts travel back to the client untouched, in the wire the client used.

## How it picks a model

- The manifest row for each request (by arrival order) is unioned with what the request body itself shows: tools present, image blocks, JSON mode.
- Candidates are the free models meeting every requirement, best rating first, brief order breaking ties.
- A JSON-mode request prefers wires that can carry JSON mode (OpenAI, Gemini) over Anthropic-wire providers, which cannot echo it.
- Dials are sequential (one provider serves one call at a time), at most 8 per request, and stop at the first success — exactly one successful provider call per request.
- Budgets are respected by never re-dialling a provider that refused: a refusal spends budget, a retry would only burn more.

## Run

```sh
node main.ts            # reads MAKEFUN_PROMPT_FILE, registers, serves
node main.ts --list     # prints the catalog document, exits 0
```

Node 22+, standard library only, no dependencies. Deterministic: every choice is a function of the brief, the requests and the providers' answers — no wall clock, no unseeded randomness.

## Entry

Built for the [make.fun](https://make.fun/bounty/free-model-aggregator-01) free-model-aggregator-01 bounty.

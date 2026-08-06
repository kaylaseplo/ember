#!/usr/bin/env python3
"""Personal AI support companion — a CLI tool for processing emotions between
therapy sessions, tracking mood, and saving insights to bring to your therapist.

Commands: chat, history, moods, summary, help
"""

import json
import sys
from datetime import datetime
from pathlib import Path

import anthropic

MODEL = "claude-opus-4-8"
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
SYSTEM_PROMPT_FILE = BASE_DIR / "SYSTEM_PROMPT.md"


def load_system_prompt() -> str:
    if SYSTEM_PROMPT_FILE.exists():
        return SYSTEM_PROMPT_FILE.read_text()
    return "You are a warm, supportive AI companion helping someone process emotions between therapy sessions."


def load_sessions() -> list[dict]:
    sessions = []
    for f in sorted(DATA_DIR.glob("session_*.json")):
        try:
            sessions.append(json.loads(f.read_text()))
        except json.JSONDecodeError:
            print(f"  (warning: could not read {f.name})")
    return sessions


def recent_context(sessions: list[dict], n: int = 3) -> str:
    """Summaries of recent sessions, given to the AI for continuity/pattern recognition."""
    recent = sessions[-n:]
    if not recent:
        return ""
    lines = []
    for s in recent:
        mood = f"mood {s['mood']}/10" if s.get("mood") else "no mood recorded"
        summary = s.get("summary") or "(no summary)"
        lines.append(f"- {s['date']} ({mood}): {summary}")
    return (
        "\n\nContext from the person's recent sessions (use this to notice patterns "
        "and provide continuity, but don't recite it back unprompted):\n" + "\n".join(lines)
    )


def stream_reply(client: anthropic.Anthropic, system: str, messages: list[dict]) -> str:
    with client.messages.stream(
        model=MODEL,
        max_tokens=2048,
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        thinking={"type": "adaptive"},
        messages=messages,
    ) as stream:
        for text in stream.text_stream:
            print(text, end="", flush=True)
        reply = stream.get_final_message()
    print()
    return "".join(b.text for b in reply.content if b.type == "text")


def generate_summary(client: anthropic.Anthropic, messages: list[dict]) -> str:
    """Brief session summary of key insights."""
    try:
        resp = client.messages.create(
            model=MODEL,
            max_tokens=300,
            system=(
                "Summarize this support conversation in 2-3 sentences for the person's "
                "own records: key themes, insights, and anything worth bringing to their "
                "therapist. Write in second person ('You explored...')."
            ),
            messages=messages
            + [{"role": "user", "content": "Please write the brief session summary now."}],
        )
        return "".join(b.text for b in resp.content if b.type == "text").strip()
    except anthropic.APIError as e:
        print(f"  (couldn't generate summary: {e})")
        return ""


def ask_mood() -> int | None:
    while True:
        raw = input("\nBefore you go — how's your mood right now, 1 (low) to 10 (great)? "
                    "(Enter to skip): ").strip()
        if not raw:
            return None
        if raw.isdigit() and 1 <= int(raw) <= 10:
            return int(raw)
        print("Please enter a number from 1 to 10.")


def cmd_chat() -> None:
    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY
    sessions = load_sessions()
    system = load_system_prompt() + recent_context(sessions)

    print("\nWelcome back. This is your space — type whatever's on your mind.")
    print("(Type 'quit' or 'exit' when you're ready to wrap up.)\n")

    messages: list[dict] = []
    while True:
        try:
            user_input = input("you > ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not user_input:
            continue
        if user_input.lower() in ("quit", "exit"):
            break

        messages.append({"role": "user", "content": user_input})
        print("\ncompanion > ", end="", flush=True)
        try:
            reply = stream_reply(client, system, messages)
        except anthropic.AuthenticationError:
            sys.exit("\nAuthentication failed — set the ANTHROPIC_API_KEY environment variable.")
        except anthropic.RateLimitError:
            print("\n(Rate limited — wait a moment and send that again.)")
            messages.pop()
            continue
        except anthropic.APIError as e:
            print(f"\n(API error: {e} — your message wasn't lost, try again.)")
            messages.pop()
            continue
        messages.append({"role": "assistant", "content": reply})
        print()

    if not messages:
        print("No conversation to save. Take care.")
        return

    mood = ask_mood()
    print("\nGenerating a brief summary of this session...")
    summary = generate_summary(client, messages)
    if summary:
        print(f"\n--- Session summary ---\n{summary}\n")

    now = datetime.now()
    session = {
        "date": now.strftime("%Y-%m-%d %H:%M"),
        "mood": mood,
        "summary": summary,
        "messages": messages,
    }
    DATA_DIR.mkdir(exist_ok=True)
    path = DATA_DIR / f"session_{now.strftime('%Y%m%d_%H%M%S')}.json"
    path.write_text(json.dumps(session, indent=2))
    print(f"Session saved to {path.name}. Take care of yourself.")


def cmd_history() -> None:
    sessions = load_sessions()
    if not sessions:
        print("No saved sessions yet. Start one with: python companion.py chat")
        return
    for i, s in enumerate(sessions, 1):
        mood = f"mood {s['mood']}/10" if s.get("mood") else "mood not recorded"
        print(f"\n[{i}] {s['date']} — {mood}")
        if s.get("summary"):
            print(f"    {s['summary']}")
    raw = input("\nEnter a session number to read the full conversation (Enter to skip): ").strip()
    if raw.isdigit() and 1 <= int(raw) <= len(sessions):
        s = sessions[int(raw) - 1]
        print(f"\n=== Session {s['date']} ===")
        for m in s["messages"]:
            speaker = "you" if m["role"] == "user" else "companion"
            print(f"\n{speaker} > {m['content']}")


def cmd_moods() -> None:
    sessions = [s for s in load_sessions() if s.get("mood")]
    if not sessions:
        print("No mood ratings recorded yet.")
        return
    print("\nMood history:\n")
    for s in sessions:
        bar = "█" * s["mood"] + "░" * (10 - s["mood"])
        print(f"  {s['date']}  {bar}  {s['mood']}/10")
    moods = [s["mood"] for s in sessions]
    avg = sum(moods) / len(moods)
    print(f"\n  Average: {avg:.1f}/10 across {len(moods)} sessions")
    if len(moods) >= 4:
        half = len(moods) // 2
        early, late = sum(moods[:half]) / half, sum(moods[half:]) / (len(moods) - half)
        if late - early >= 0.5:
            print(f"  Trend: improving (recent avg {late:.1f} vs earlier {early:.1f})")
        elif early - late >= 0.5:
            print(f"  Trend: dipping (recent avg {late:.1f} vs earlier {early:.1f})")
        else:
            print("  Trend: steady")


def cmd_summary() -> None:
    """Cross-session pattern recognition: recurring themes across recent sessions."""
    sessions = load_sessions()
    with_summaries = [s for s in sessions if s.get("summary")]
    if len(with_summaries) < 2:
        print("Need at least 2 sessions with summaries to look for patterns.")
        return
    client = anthropic.Anthropic()
    notes = "\n".join(
        f"- {s['date']} (mood {s.get('mood', '?')}/10): {s['summary']}"
        for s in with_summaries[-10:]
    )
    print("\nLooking for patterns across your recent sessions...\n")
    try:
        stream_reply(
            client,
            "You help someone review their mental-health journey between therapy sessions. "
            "Given their session summaries and mood ratings, identify recurring themes, "
            "possible triggers, and progress — written warmly in second person, in a form "
            "they could bring to their therapist. Keep it under 250 words.",
            [{"role": "user", "content": f"My recent session notes:\n{notes}"}],
        )
    except anthropic.APIError as e:
        sys.exit(f"API error: {e}")


def cmd_help() -> None:
    print(__doc__)
    print("""Usage: python companion.py <command>

  chat      Start a support conversation (saves it, asks mood at the end)
  history   Browse past conversations and summaries
  moods     View mood ratings and trend
  summary   Spot recurring themes across recent sessions
  help      Show this message

Setup: export ANTHROPIC_API_KEY=sk-ant-...
Data is stored as JSON files in ./data/ — yours to read, edit, or delete.""")


def main() -> None:
    commands = {"chat": cmd_chat, "history": cmd_history, "moods": cmd_moods,
                "summary": cmd_summary, "help": cmd_help}
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    commands.get(cmd, cmd_help)()


if __name__ == "__main__":
    main()

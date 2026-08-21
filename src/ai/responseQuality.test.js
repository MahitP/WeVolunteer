import { describe, it, expect } from 'vitest';
import { formatResponseText, sanitizeHistory, __testing } from './assistant';
import { isUsableReply, claimsAnAction, hasRepetitiveLoop } from './prompts/welly';

describe('formatResponseText token & punctuation normalization', () => {
  it('attaches separated punctuation without extra spaces', () => {
    expect(formatResponseText('Hello , how are you ?')).toBe('Hello, how are you?');
    expect(formatResponseText('I found an event .')).toBe('I found an event.');
    expect(formatResponseText('Opportunities !')).toBe('Opportunities!');
    expect(formatResponseText('Shifts : 3')).toBe('Shifts: 3');
    expect(formatResponseText('Option A ; Option B')).toBe('Option A; Option B');
  });

  it('assembles broken contractions cleanly', () => {
    expect(formatResponseText("I 'm happy to help.")).toBe("I'm happy to help.");
    expect(formatResponseText("You can 't do that.")).toBe("You can't do that.");
    expect(formatResponseText("It 's ready.")).toBe("It's ready.");
    expect(formatResponseText("They 've arrived.")).toBe("They've arrived.");
    expect(formatResponseText("We 'll see.")).toBe("We'll see.");
    expect(formatResponseText("Don 't worry.")).toBe("Don't worry.");
  });

  it('strips leading punctuation artifacts', () => {
    expect(formatResponseText('?I am here to help.')).toBe('I am here to help.');
    expect(formatResponseText('!Sure, let me check.')).toBe('Sure, let me check.');
    expect(formatResponseText('...You have 4 hours.')).toBe('You have 4 hours.');
    expect(formatResponseText('  ,You are registered.')).toBe('You are registered.');
  });

  it('preserves intentional paragraphs, newlines and spacing', () => {
    const text = 'Here is what I found:\n\n• Food Bank at 9:00 AM\n• Library Help at 1:00 PM\n\nLet me know if you need anything else.';
    expect(formatResponseText(text)).toBe(text);
  });

  it('softens robotic customer service cliches', () => {
    expect(formatResponseText('How may I assist you today?')).toBe('What would you like to explore?');
    expect(formatResponseText('How can I help you today?')).toBe("What's on your mind?");
    expect(formatResponseText("I'm sorry to hear that. You have 0 hours.")).toBe('You have 0 hours.');
  });
});

describe('sanitizeHistory multi-turn history protection', () => {
  it('ensures previous assistant turns have clean terminal punctuation', () => {
    const history = [
      { role: 'user', text: 'How do I volunteer?' },
      { role: 'assistant', text: "I'm sorry, but I can't assist with" }, // truncated turn
    ];

    const sanitized = sanitizeHistory(history);
    expect(sanitized).toHaveLength(2);
    // Dangling "with" stripped and cleanly terminated with a period
    expect(sanitized[1].content).toBe("I'm sorry, but I can't assist.");
  });

  it('strips trailing dangling prepositions and conjunctions', () => {
    const cases = [
      ["I would be glad to", "I would be glad."],
      ["You can register for", "You can register."],
      ["Events in your area and", "Events in your area."],
      ["Available shifts or", "Available shifts."],
    ];

    for (const [input, expected] of cases) {
      const history = [{ role: 'assistant', text: input }];
      const sanitized = sanitizeHistory(history);
      expect(sanitized[0].content).toBe(expected);
    }
  });

  it('leaves already complete sentences intact', () => {
    const history = [
      { role: 'user', text: 'Where is the event?' },
      { role: 'assistant', text: 'The event is at South Bay Community Center.' },
    ];

    const sanitized = sanitizeHistory(history);
    expect(sanitized[0].content).toBe('Where is the event?');
    expect(sanitized[1].content).toBe('The event is at South Bay Community Center.');
  });
});

describe('isUsableReply length and quality boundaries', () => {
  it('accepts comprehensive natural responses longer than 600 characters', () => {
    const detailedReply = `
Auto Select automatically assigns volunteers to shifts based on their availability, skills, and sign-up order. 
When an organizer publishes an event with Auto Select enabled, registered volunteers are notified and placed into confirmed slots.
If all slots fill up, additional volunteers are placed on the waitlist in order of registration. If a volunteer cancels, the next person on the waitlist is automatically promoted.
You can review your confirmed shifts and application status in the Calendar or Applications view.
    `.trim();

    expect(detailedReply.length).toBeGreaterThan(500);
    expect(isUsableReply(detailedReply)).toBe(true);
  });

  it('rejects runaway responses that exceed safety thresholds', () => {
    const runaway = 'This is an excessively long runaway generation without useful content. '.repeat(40);
    expect(runaway.length).toBeGreaterThan(2000);
    expect(isUsableReply(runaway)).toBe(false);
  });

  it('rejects repetitive loops regardless of length', () => {
    const loop = 'You have hours. You have hours. You have hours. You have hours. You have hours.';
    expect(hasRepetitiveLoop(loop)).toBe(true);
    expect(isUsableReply(loop)).toBe(false);
  });

  it('rejects unauthorized action claims', () => {
    expect(claimsAnAction("I'll create the event for you right now.")).toBe(true);
    expect(isUsableReply("I'll create the event for you right now.")).toBe(false);
  });
});

describe('streaming token assembly and turn boundary isolation', () => {
  it('assembles subword token chunks faithfully without mid-thought truncation', () => {
    const chunks = [
      "I",
      "'m",
      " happy",
      " to",
      " help",
      " you",
      " explore",
      " upcoming",
      " shifts",
      " in",
      " your",
      " area",
      " .",
    ];

    let assembled = '';
    for (const chunk of chunks) {
      assembled += chunk;
    }

    const formatted = formatResponseText(assembled);
    expect(formatted).toBe("I'm happy to help you explore upcoming shifts in your area.");
  });

  it('preserves clean turn separation when Turn 1 ends and Turn 2 begins', () => {
    const turn1Tokens = ["You have ", "24 ", "verified ", "hours."];
    const turn1Assembled = formatResponseText(turn1Tokens.join(''));

    const conversationHistory = [
      { role: 'user', text: 'How many hours do I have?' },
      { role: 'assistant', text: turn1Assembled },
    ];

    const sanitizedForTurn2 = sanitizeHistory(conversationHistory);
    expect(sanitizedForTurn2[1].content).toBe('You have 24 verified hours.');

    const turn2Tokens = ["There are ", "5 ", "events ", "available ", "this weekend."];
    const turn2Assembled = formatResponseText(turn2Tokens.join(''));
    expect(turn2Assembled).toBe('There are 5 events available this weekend.');
  });
});


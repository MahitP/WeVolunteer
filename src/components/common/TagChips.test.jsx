import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import TagChips from './TagChips';
import TagInput from './TagInput';
import { MAX_TAGS_PER_EVENT } from '../../eventTags.js';

const tag = (label) => ({ tag: label.toLowerCase(), label });

describe('TagChips', () => {
  it('renders nothing at all when an event has no tags', () => {
    const { container } = render(<TagChips tags={[]} />);
    /* Not an empty list with a label — a card with no tags should have no row,
       not a row containing nothing, which would still cost vertical space. */
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the organizer\'s spelling, not the normalised key', () => {
    render(<TagChips tags={[{ tag: 'animalshelter', label: 'AnimalShelter' }]} />);
    expect(screen.getByText('AnimalShelter')).toBeInTheDocument();
    expect(screen.queryByText('animalshelter')).not.toBeInTheDocument();
  });

  /**
   * The hash is decoration.
   *
   * Rendered for the reader and `aria-hidden`, so a screen reader says
   * "AnimalShelter" rather than "hash AnimalShelter" eight times in a row. It is
   * never stored — the normaliser strips it so `#NHS` and `NHS` are one concept.
   */
  it('hides the decorative hash from assistive technology', () => {
    render(<TagChips tags={[tag('NHS')]} />);
    const list = screen.getByRole('list', { name: /tags/i });
    expect(within(list).getByText('#')).toHaveAttribute('aria-hidden', 'true');
  });

  /**
   * A card with many tags must not grow a third line.
   *
   * Eight chips wrap far enough to push the date and the spots count out of a card
   * somebody is scanning a list of, which is the layout failure this limit exists
   * for.
   */
  it('caps the visible chips and counts the rest', () => {
    render(<TagChips tags={['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map(tag)} limit={3} />);

    expect(screen.getByText('One')).toBeInTheDocument();
    expect(screen.queryByText('Four')).not.toBeInTheDocument();
    /* Names the count rather than just "+3", which is not a sentence. */
    expect(screen.getByRole('button', { name: /show 3 more tags/i })).toBeInTheDocument();
  });

  it('says "tag" rather than "tags" when exactly one is hidden', () => {
    render(<TagChips tags={['One', 'Two'].map(tag)} limit={1} />);
    expect(screen.getByRole('button', { name: /show 1 more tag$/i })).toBeInTheDocument();
  });

  /** The overflow control expands in place. A `+3` that navigates away is a trap. */
  it('reveals the rest on demand and can collapse again', () => {
    render(<TagChips tags={['One', 'Two', 'Three', 'Four'].map(tag)} limit={2} />);

    fireEvent.click(screen.getByRole('button', { name: /show 2 more tags/i }));
    expect(screen.getByText('Four')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /show fewer tags/i }));
    expect(screen.queryByText('Four')).not.toBeInTheDocument();
  });

  /**
   * Inert by default, interactive only where a filter exists to drive.
   *
   * A chip that looks clickable on a card with nothing to filter promises
   * something that does not happen.
   */
  it('is not a button unless a select handler is given', () => {
    const { rerender } = render(<TagChips tags={[tag('NHS')]} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(<TagChips tags={[tag('NHS')]} onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: /filter by NHS/i })).toBeInTheDocument();
  });

  it('reports the normalised key, not the label, when selected', () => {
    const onSelect = vi.fn();
    render(<TagChips tags={[{ tag: 'animalshelter', label: 'AnimalShelter' }]} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: /filter by AnimalShelter/i }));
    /* The key is what the server filters on and what a shareable URL carries. */
    expect(onSelect).toHaveBeenCalledWith('animalshelter');
  });
});

describe('TagInput', () => {
  const field = () => screen.getByLabelText('Tags');

  const type = (text) => fireEvent.change(field(), { target: { value: text } });
  const enter = () => fireEvent.keyDown(field(), { key: 'Enter' });

  it('says tags are optional in the first word', () => {
    render(<TagInput value={[]} onChange={() => {}} />);
    expect(screen.getByText(/^Optional\./)).toBeInTheDocument();
  });

  it('adds an arbitrary tag nobody predefined', () => {
    const onChange = vi.fn();
    render(<TagInput value={[]} onChange={onChange} />);

    type('CommunityGarden');
    enter();

    expect(onChange).toHaveBeenCalledWith([{ tag: 'communitygarden', label: 'CommunityGarden' }]);
  });

  /** Enter means "add this tag", never "publish this half-filled event". */
  it('does not submit the surrounding form on Enter', () => {
    const onSubmit = vi.fn(e => e.preventDefault());
    render(<form onSubmit={onSubmit}><TagInput value={[]} onChange={() => {}} /></form>);

    type('NHS');
    enter();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('normalises as the server would, stripping the hash', () => {
    const onChange = vi.fn();
    render(<TagInput value={[]} onChange={onChange} />);

    type('# NHS');
    enter();

    expect(onChange).toHaveBeenCalledWith([{ tag: 'nhs', label: 'NHS' }]);
  });

  /** A repeat is the same tag, not a mistake — cleared, not flagged. */
  it('ignores a tag the event already carries without complaining', () => {
    const onChange = vi.fn();
    render(<TagInput value={[tag('NHS')]} onChange={onChange} />);

    type('#nhs');
    enter();

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(field()).toHaveValue('');
  });

  it('explains a tag it cannot use instead of silently dropping it', () => {
    render(<TagInput value={[]} onChange={() => {}} />);

    type('<script>');
    enter();

    expect(screen.getByRole('alert')).toHaveTextContent(/letters, numbers, spaces or hyphens/i);
  });

  /**
   * Committed on blur as well as on Enter.
   *
   * Somebody who types a tag and then clicks Save expects the tag they can still
   * see in the box to be saved — the most likely way to lose input here.
   */
  it('commits a typed tag when the field loses focus', () => {
    const onChange = vi.fn();
    render(<TagInput value={[]} onChange={onChange} />);

    type('Library');
    fireEvent.blur(field());

    expect(onChange).toHaveBeenCalledWith([{ tag: 'library', label: 'Library' }]);
  });

  it('removes a chip, and names which one in its button', () => {
    const onChange = vi.fn();
    render(<TagInput value={[tag('NHS'), tag('Pets')]} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove tag Pets' }));

    expect(onChange).toHaveBeenCalledWith([tag('NHS')]);
  });

  /** The behaviour every token field has, and the one a keyboard user tries first. */
  it('removes the last chip on Backspace in an empty field', () => {
    const onChange = vi.fn();
    render(<TagInput value={[tag('NHS'), tag('Pets')]} onChange={onChange} />);

    fireEvent.keyDown(field(), { key: 'Backspace' });

    expect(onChange).toHaveBeenCalledWith([tag('NHS')]);
  });

  it('does not eat a chip when Backspace is pressed with text present', () => {
    const onChange = vi.fn();
    render(<TagInput value={[tag('NHS')]} onChange={onChange} />);

    type('Pe');
    fireEvent.keyDown(field(), { key: 'Backspace' });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('stops accepting tags at the maximum and says why', () => {
    const full = Array.from({ length: MAX_TAGS_PER_EVENT }, (_, i) => tag(`Tag${i}`));
    render(<TagInput value={full} onChange={() => {}} />);

    expect(field()).toBeDisabled();
    expect(field()).toHaveAttribute('placeholder', expect.stringContaining(String(MAX_TAGS_PER_EVENT)));
  });

  /**
   * Suggestions are a shortcut, never a gate.
   *
   * Offered so three organizers do not invent `FoodDrive`, `Food Drive` and
   * `food-drive` for one thing — but anything typed is still accepted.
   */
  it('offers existing tags without excluding a new one', () => {
    const onChange = vi.fn();
    render(
      <TagInput
        value={[]}
        onChange={onChange}
        suggestions={[{ tag: 'nhs', label: 'NHS' }, { tag: 'pets', label: 'Pets' }]}
      />
    );

    /* `combobox`, not `textbox`: an input carrying `list` IS a combobox, which is
       what a screen reader announces and is exactly the right semantics for a
       field with suggestions. The options live in the DOM rather than in a custom
       popup that could trap focus or render behind a modal. */
    expect(screen.getByRole('combobox', { name: 'Tags' })).toHaveAttribute('list');

    type('CommunityGarden');
    enter();
    expect(onChange).toHaveBeenCalledWith([{ tag: 'communitygarden', label: 'CommunityGarden' }]);
  });

  it('does not suggest a tag the event already has', () => {
    const { container } = render(
      <TagInput
        value={[tag('NHS')]}
        onChange={() => {}}
        suggestions={[{ tag: 'nhs', label: 'NHS' }, { tag: 'pets', label: 'Pets' }]}
      />
    );

    const options = [...container.querySelectorAll('datalist option')].map(o => o.value);
    expect(options).toEqual(['Pets']);
  });
});

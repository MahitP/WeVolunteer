import React, { useState } from 'react';
import { AlertCircle, Plus, Trash2 } from 'lucide-react';
import { isoToLocalInput } from '../utils/helpers';
import DateTimeField from './common/DateTimeField';
import { LocationPicker } from './location';
import { CATEGORY_GROUPS } from '../eventCategories';

/**
 * ── This list used to be wrong, and had been since it was written ──
 *
 * It read `School, Community, Library, Environment, Health, Civic`. Four of
 * those six — Community, Library, Civic, and at the time Environment and Health
 * too — were never values this platform stores. `VALID_CATEGORIES` was
 * `School | 5K | Food Pantry | Fundraiser | Other`, so an organizer who opened
 * this form and changed the category to "Library" got a 400 from
 * `PUT /api/events/:id` naming a field they had just chosen from a dropdown
 * this app gave them. Worse, the form offered NO way back to `5K`, `Food Pantry`
 * or `Fundraiser`: an event in one of those categories showed a select with no
 * matching option, and the first save silently re-filed it as `School`.
 *
 * The fix is not a corrected literal — a corrected literal is the same bug
 * waiting for the next vocabulary change. It is the shared module, which is also
 * what the CHECK constraint and the server's validator are built from.
 */
export default function EventEditForm({
  event,
  onSave,
  onCancel,
  addToast
}) {
  const [submitting, setSubmitting] = useState(false);
  const [editForm, setEditForm] = useState({
    title: event.title,
    category: event.category,
    description: event.description,
    instructions: event.instructions || '',
    location: {
      location: event.location,
      address: event.address || null,
      latitude: event.latitude != null ? event.latitude : null,
      longitude: event.longitude != null ? event.longitude : null
    },
    applicationDeadline: event.applicationDeadline,
    attendeeVisibility: event.attendeeVisibility || 'accepted'
  });
  const [editSlots, setEditSlots] = useState(event.slots || []);
  const [editErrors, setEditErrors] = useState({});
  const validateEdit = () => {
    const errs = {};
    if (!editForm.title.trim()) errs.title = 'Give the event a name';
    if (!editForm.description.trim()) errs.description = 'Describe what volunteers will do';
    const locText = typeof editForm.location === 'string' ? editForm.location : editForm.location?.location;
    if (!locText?.trim()) errs.location = 'Add a location';
    if (!editForm.applicationDeadline) errs.applicationDeadline = 'Set an application deadline';
    if (editSlots.length === 0) errs.slots = 'An event needs at least one shift';
    editSlots.forEach((slot, i) => {
      if (!slot.name?.trim()) errs[`slot-${i}-name`] = 'Name this shift';
      if (!slot.startDatetime || !slot.endDatetime) errs[`slot-${i}-time`] = 'Set a start and end time';else if (new Date(slot.startDatetime) >= new Date(slot.endDatetime)) {
        errs[`slot-${i}-time`] = 'End time must be after the start time';
      }
      if (Number(slot.maxSpots) <= 0) errs[`slot-${i}-maxSpots`] = 'At least one spot';
    });
    /**
     * The deadline cannot land after the event.
     *
     * `validateEventPayload` refuses this on the server and always has, so the
     * edit could not actually SAVE an inverted pair — it just did not say so
     * until the round trip came back, and the message arrived as a toast next to
     * a form with nothing highlighted. The create form has checked it inline
     * since it was written; this is the same check on the other half of the same
     * rule, reported on the field it belongs to.
     */
    const starts = editSlots.map(s => Date.parse(s.startDatetime)).filter(t => !Number.isNaN(t));
    if (editForm.applicationDeadline && starts.length > 0) {
      const deadline = Date.parse(editForm.applicationDeadline);
      if (!Number.isNaN(deadline) && deadline > Math.min(...starts)) {
        errs.applicationDeadline = 'The deadline has to be on or before the first shift starts';
      }
    }
    setEditErrors(errs);
    return Object.keys(errs).length === 0;
  };
  const handleSave = async e => {
    e.preventDefault();
    if (!validateEdit()) {
      addToast('Check the highlighted fields before saving.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const loc = typeof editForm.location === 'string'
        ? { location: editForm.location, address: null, latitude: null, longitude: null }
        : editForm.location;
      const payload = {
        ...editForm,
        location: loc.location,
        address: loc.address || null,
        latitude: loc.latitude != null ? loc.latitude : null,
        longitude: loc.longitude != null ? loc.longitude : null,
        applicationDeadline: new Date(editForm.applicationDeadline).toISOString(),
        autoApprove: event.autoApprove,
        slots: editSlots.map(s => ({
          id: s.id || `new-${Date.now()}-${Math.random()}`,
          name: s.name,
          description: s.description,
          startDatetime: new Date(s.startDatetime).toISOString(),
          endDatetime: new Date(s.endDatetime).toISOString(),
          maxSpots: Number(s.maxSpots)
        }))
      };
      await onSave(payload);
    } finally {
      setSubmitting(false);
    }
  };
  const changeSlot = (i, field, value) => setEditSlots(prev => prev.map((s, idx) => idx === i ? {
    ...s,
    [field]: value
  } : s));
  const addSlot = () => {
    const base = event.slots?.[0]?.startDatetime || new Date().toISOString();
    const day = isoToLocalInput(base).split('T')[0];
    setEditSlots(prev => [...prev, {
      id: `new-${Date.now()}`,
      name: '',
      description: '',
      startDatetime: `${day}T09:00`,
      endDatetime: `${day}T11:00`,
      maxSpots: 2
    }]);
  };
  return <form id="edit-event-form" className="modal-body" onSubmit={handleSave}>
      <div className="field">
        <label htmlFor="ev-title">Event name</label>
        <input id="ev-title" className="input" value={editForm.title} aria-invalid={!!editErrors.title} onChange={e => setEditForm(f => ({
        ...f,
        title: e.target.value
      }))} />
        {editErrors.title && <span className="field-error"><AlertCircle size={12} />{editErrors.title}</span>}
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="ev-cat">Category</label>
          <select id="ev-cat" className="select" value={editForm.category} onChange={e => setEditForm(f => ({
          ...f,
          category: e.target.value
        }))}>
            {CATEGORY_GROUPS.map(({ group, categories }) => (
              <optgroup key={group} label={group}>
                {categories.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="field">
          {/* The app's date picker and a time box, not the browser's
              datetime control (ruling 8). The picker shows the error. */}
          <DateTimeField
            id="ev-deadline"
            label="Applications close"
            timeLabel="Closing time"
            value={isoToLocalInput(editForm.applicationDeadline)}
            defaultTime="17:00"
            error={editErrors.applicationDeadline || ''}
            onChange={v => setEditForm(f => ({ ...f, applicationDeadline: v }))}
          />
        </div>
      </div>

      <div className="field">
        <label>Location</label>
        <LocationPicker
          value={editForm.location}
          onChange={(loc) => setEditForm(f => ({ ...f, location: loc }))}
          error={editErrors.location}
        />
      </div>

      <div className="field">
        <label htmlFor="ev-desc">What volunteers will be doing</label>
        <textarea id="ev-desc" className="textarea" value={editForm.description} aria-invalid={!!editErrors.description} onChange={e => setEditForm(f => ({
        ...f,
        description: e.target.value
      }))} />
        {editErrors.description && <span className="field-error"><AlertCircle size={12} />{editErrors.description}</span>}
      </div>

      <div className="field">
        <label htmlFor="ev-instr">Arrival instructions <span className="dim s-fe3f5c">(optional)</span></label>
        <textarea id="ev-instr" className="textarea s-635b9f" value={editForm.instructions} placeholder="Where to park, who to check in with, what to bring." onChange={e => setEditForm(f => ({
        ...f,
        instructions: e.target.value
      }))} />
        <span className="field-hint">Shown to volunteers once they're confirmed.</span>
      </div>

      <div className="field">
        <span className="label">Who can see the volunteer list</span>
        <div className="stack-sm">
          <label className="check" data-checked={editForm.attendeeVisibility === 'accepted' ? 'true' : 'false'}>
            <input type="radio" name="vis" checked={editForm.attendeeVisibility === 'accepted'} onChange={() => setEditForm(f => ({
            ...f,
            attendeeVisibility: 'accepted'
          }))} />
            <span>
              <span className="check-title">Confirmed volunteers</span>
              <span className="check-desc">Anyone accepted can see who else is coming. Recommended — it helps people coordinate rides and feel part of a group.</span>
            </span>
          </label>
          <label className="check" data-checked={editForm.attendeeVisibility === 'private' ? 'true' : 'false'}>
            <input type="radio" name="vis" checked={editForm.attendeeVisibility === 'private'} onChange={() => setEditForm(f => ({
            ...f,
            attendeeVisibility: 'private'
          }))} />
            <span>
              <span className="check-title">Only me</span>
              <span className="check-desc">Volunteers see how many spots are taken, but not who has them.</span>
            </span>
          </label>
        </div>
      </div>

      <div className="section-head s-473e7f">
        <h3>Shifts</h3>
        <button type="button" className="btn btn-secondary btn-sm section-action" onClick={addSlot}>
          <Plus size={13} /> Add shift
        </button>
      </div>

      {editErrors.slots && <div className="alert alert-danger s-22c500">{editErrors.slots}</div>}

      <div className="stack">
        {editSlots.map((slot, i) => <div key={slot.id || i} className="inset">
            <div className="row-between s-450599">
              <span className="eyebrow">Shift {i + 1}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditSlots(prev => prev.filter((_, idx) => idx !== i))} aria-label={`Remove shift ${i + 1}`}>
                <Trash2 size={13} />
              </button>
            </div>

            <div className="field-row s-535b39">
              <div className="field">
                <label>Role</label>
                <input className="input" value={slot.name || ''} placeholder="e.g. Grill helper" aria-invalid={!!editErrors[`slot-${i}-name`]} onChange={e => changeSlot(i, 'name', e.target.value)} />
                {editErrors[`slot-${i}-name`] && <span className="field-error">{editErrors[`slot-${i}-name`]}</span>}
              </div>
              <div className="field">
                <label>Spots</label>
                <input type="number" min="1" className="input" value={slot.maxSpots} aria-invalid={!!editErrors[`slot-${i}-maxSpots`]} onChange={e => changeSlot(i, 'maxSpots', e.target.value)} />
                {editErrors[`slot-${i}-maxSpots`] && <span className="field-error">{editErrors[`slot-${i}-maxSpots`]}</span>}
              </div>
            </div>

            {/* Two named halves each, where these were two unlabelled browser
                datetime controls: the labels had no `htmlFor`, so neither box
                had a name a screen reader could read. */}
            <DateTimeField
              id={`ev-slot-${i}-start`}
              label="Starts"
              timeLabel="Start time"
              value={isoToLocalInput(slot.startDatetime)}
              onChange={v => changeSlot(i, 'startDatetime', v)}
            />
            <DateTimeField
              id={`ev-slot-${i}-end`}
              label="Ends"
              timeLabel="End time"
              value={isoToLocalInput(slot.endDatetime)}
              defaultTime="11:00"
              onChange={v => changeSlot(i, 'endDatetime', v)}
            />
            {editErrors[`slot-${i}-time`] && <span className="field-error s-57a71b">
                <AlertCircle size={12} />{editErrors[`slot-${i}-time`]}
              </span>}

            <div className="field">
              <label>Details (optional)</label>
              <input className="input" value={slot.description || ''} placeholder="e.g. Bring closed-toe shoes" onChange={e => changeSlot(i, 'description', e.target.value)} />
            </div>
          </div>)}
      </div>

      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type="submit" form="edit-event-form" className="btn btn-primary" disabled={submitting}>Save changes</button>
      </div>
    </form>;
}
import React, { useState } from 'react';
import { AlertCircle, Plus, Trash2 } from 'lucide-react';
import { isoToLocalInput } from '../utils/helpers';

const CATEGORIES = [
  { value: 'School', label: 'School' },
  { value: 'Community', label: 'Community' },
  { value: 'Library', label: 'Library' },
  { value: 'Environment', label: 'Environment' },
  { value: 'Health', label: 'Health' },
  { value: 'Civic', label: 'Civic' }
];

export default function EventEditForm({ event, onSave, onCancel, addToast }) {
  const [submitting, setSubmitting] = useState(false);
  const [editForm, setEditForm] = useState({
    title: event.title,
    category: event.category,
    description: event.description,
    instructions: event.instructions || '',
    location: event.location,
    applicationDeadline: event.applicationDeadline,
    attendeeVisibility: event.attendeeVisibility || 'accepted'
  });
  const [editSlots, setEditSlots] = useState(event.slots || []);
  const [editErrors, setEditErrors] = useState({});

  const validateEdit = () => {
    const errs = {};
    if (!editForm.title.trim()) errs.title = 'Give the event a name';
    if (!editForm.description.trim()) errs.description = 'Describe what volunteers will do';
    if (!editForm.location.trim()) errs.location = 'Add a location';
    if (!editForm.applicationDeadline) errs.applicationDeadline = 'Set an application deadline';
    if (editSlots.length === 0) errs.slots = 'An event needs at least one shift';

    editSlots.forEach((slot, i) => {
      if (!slot.name?.trim()) errs[`slot-${i}-name`] = 'Name this shift';
      if (!slot.startDatetime || !slot.endDatetime) errs[`slot-${i}-time`] = 'Set a start and end time';
      else if (new Date(slot.startDatetime) >= new Date(slot.endDatetime)) {
        errs[`slot-${i}-time`] = 'End time must be after the start time';
      }
      if (Number(slot.maxSpots) <= 0) errs[`slot-${i}-maxSpots`] = 'At least one spot';
    });

    setEditErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!validateEdit()) {
      addToast('Check the highlighted fields before saving.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        ...editForm,
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

  const changeSlot = (i, field, value) =>
    setEditSlots(prev => prev.map((s, idx) => (idx === i ? { ...s, [field]: value } : s)));

  const addSlot = () => {
    const base = event.slots?.[0]?.startDatetime || new Date().toISOString();
    const day = isoToLocalInput(base).split('T')[0];
    setEditSlots(prev => [...prev, {
      id: `new-${Date.now()}`, name: '', description: '',
      startDatetime: `${day}T09:00`, endDatetime: `${day}T11:00`, maxSpots: 2
    }]);
  };

  return (
    <form id="edit-event-form" className="modal-body" onSubmit={handleSave}>
      <div className="field">
        <label htmlFor="ev-title">Event name</label>
        <input id="ev-title" className="input" value={editForm.title}
          aria-invalid={!!editErrors.title}
          onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))} />
        {editErrors.title && <span className="field-error"><AlertCircle size={12} />{editErrors.title}</span>}
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="ev-cat">Category</label>
          <select id="ev-cat" className="select" value={editForm.category}
            onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))}>
            {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ev-deadline">Applications close</label>
          <input id="ev-deadline" type="datetime-local" className="input"
            value={isoToLocalInput(editForm.applicationDeadline)}
            aria-invalid={!!editErrors.applicationDeadline}
            onChange={e => setEditForm(f => ({ ...f, applicationDeadline: e.target.value }))} />
          {editErrors.applicationDeadline && (
            <span className="field-error"><AlertCircle size={12} />{editErrors.applicationDeadline}</span>
          )}
        </div>
      </div>

      <div className="field">
        <label htmlFor="ev-loc">Location</label>
        <input id="ev-loc" className="input" value={editForm.location}
          aria-invalid={!!editErrors.location}
          onChange={e => setEditForm(f => ({ ...f, location: e.target.value }))} />
        {editErrors.location && <span className="field-error"><AlertCircle size={12} />{editErrors.location}</span>}
      </div>

      <div className="field">
        <label htmlFor="ev-desc">What volunteers will be doing</label>
        <textarea id="ev-desc" className="textarea" value={editForm.description}
          aria-invalid={!!editErrors.description}
          onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} />
        {editErrors.description && <span className="field-error"><AlertCircle size={12} />{editErrors.description}</span>}
      </div>

      <div className="field">
        <label htmlFor="ev-instr">Arrival instructions <span className="dim" style={{ fontWeight: 400 }}>(optional)</span></label>
        <textarea id="ev-instr" className="textarea" style={{ minHeight: 64 }}
          value={editForm.instructions}
          placeholder="Where to park, who to check in with, what to bring."
          onChange={e => setEditForm(f => ({ ...f, instructions: e.target.value }))} />
        <span className="field-hint">Shown to volunteers once they're confirmed.</span>
      </div>

      <div className="field">
        <span className="label">Who can see the volunteer list</span>
        <div className="stack-sm">
          <label className="check" data-checked={editForm.attendeeVisibility === 'accepted' ? 'true' : 'false'}>
            <input type="radio" name="vis" checked={editForm.attendeeVisibility === 'accepted'}
              onChange={() => setEditForm(f => ({ ...f, attendeeVisibility: 'accepted' }))} />
            <span>
              <span className="check-title">Confirmed volunteers</span>
              <span className="check-desc">Anyone accepted can see who else is coming. Recommended — it helps people coordinate rides and feel part of a group.</span>
            </span>
          </label>
          <label className="check" data-checked={editForm.attendeeVisibility === 'private' ? 'true' : 'false'}>
            <input type="radio" name="vis" checked={editForm.attendeeVisibility === 'private'}
              onChange={() => setEditForm(f => ({ ...f, attendeeVisibility: 'private' }))} />
            <span>
              <span className="check-title">Only me</span>
              <span className="check-desc">Volunteers see how many spots are taken, but not who has them.</span>
            </span>
          </label>
        </div>
      </div>

      <div className="section-head" style={{ marginTop: 'var(--s6)' }}>
        <h3>Shifts</h3>
        <button type="button" className="btn btn-secondary btn-sm section-action" onClick={addSlot}>
          <Plus size={13} /> Add shift
        </button>
      </div>

      {editErrors.slots && (
        <div className="alert alert-danger" style={{ marginBottom: 'var(--s4)' }}>{editErrors.slots}</div>
      )}

      <div className="stack">
        {editSlots.map((slot, i) => (
          <div key={slot.id || i} className="inset">
            <div className="row-between" style={{ marginBottom: 'var(--s3)' }}>
              <span className="eyebrow">Shift {i + 1}</span>
              <button type="button" className="btn btn-ghost btn-sm"
                onClick={() => setEditSlots(prev => prev.filter((_, idx) => idx !== i))}
                aria-label={`Remove shift ${i + 1}`}>
                <Trash2 size={13} />
              </button>
            </div>

            <div className="field-row" style={{ marginTop: 0 }}>
              <div className="field">
                <label>Role</label>
                <input className="input" value={slot.name || ''} placeholder="e.g. Grill helper"
                  aria-invalid={!!editErrors[`slot-${i}-name`]}
                  onChange={e => changeSlot(i, 'name', e.target.value)} />
                {editErrors[`slot-${i}-name`] && <span className="field-error">{editErrors[`slot-${i}-name`]}</span>}
              </div>
              <div className="field">
                <label>Spots</label>
                <input type="number" min="1" className="input" value={slot.maxSpots}
                  aria-invalid={!!editErrors[`slot-${i}-maxSpots`]}
                  onChange={e => changeSlot(i, 'maxSpots', e.target.value)} />
                {editErrors[`slot-${i}-maxSpots`] && <span className="field-error">{editErrors[`slot-${i}-maxSpots`]}</span>}
              </div>
            </div>

            <div className="field-row">
              <div className="field">
                <label>Starts</label>
                <input type="datetime-local" className="input" value={isoToLocalInput(slot.startDatetime)}
                  onChange={e => changeSlot(i, 'startDatetime', e.target.value)} />
              </div>
              <div className="field">
                <label>Ends</label>
                <input type="datetime-local" className="input" value={isoToLocalInput(slot.endDatetime)}
                  onChange={e => changeSlot(i, 'endDatetime', e.target.value)} />
              </div>
            </div>
            {editErrors[`slot-${i}-time`] && (
              <span className="field-error" style={{ marginTop: 6 }}>
                <AlertCircle size={12} />{editErrors[`slot-${i}-time`]}
              </span>
            )}

            <div className="field">
              <label>Details (optional)</label>
              <input className="input" value={slot.description || ''} placeholder="e.g. Bring closed-toe shoes"
                onChange={e => changeSlot(i, 'description', e.target.value)} />
            </div>
          </div>
        ))}
      </div>

      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type="submit" form="edit-event-form" className="btn btn-primary" disabled={submitting}>Save changes</button>
      </div>
    </form>
  );
}

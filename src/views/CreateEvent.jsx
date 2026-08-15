import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Calendar, Plus, AlertCircle, Trash2, Info, X } from 'lucide-react';
import { formatHours } from '../utils/helpers';
import { LocationPicker } from '../components/location';
import TagInput from '../components/common/TagInput';
import TagSuggestions from '../components/common/TagSuggestions';
import { normaliseTag } from '../eventTags';
import DatePicker from '../components/common/DatePicker';
import { api } from '../utils/api';
import { can } from '../authz';
const CATEGORIES = [{
  value: 'School',
  label: 'School project'
}, {
  value: '5K',
  label: '5K run / athletics'
}, {
  value: 'Food Pantry',
  label: 'Food pantry'
}, {
  value: 'Fundraiser',
  label: 'Fundraiser'
}, {
  value: 'Other',
  label: 'Other community service'
}];
export default function CreateEvent({
  onSubmitEvent,
  addToast,
  setActiveTab,
  currentUser
}) {
  /**
   * A Student Organizer reached this page on `organization.event.create`, which
   * only ever means "for a club you help run". They have no `event.create`, so
   * an event with no organization behind it is not theirs to make — the server
   * answers 403 `organization_required`, and this is the same rule said before
   * the request rather than after it.
   *
   * Read from the capability rather than from the role, so it stays true if the
   * rank is ever given to somebody who is not a student.
   */
  const orgRequired = Boolean(currentUser) && !can(currentUser, 'event.create');
  /**
   * The organizations this account may publish under.
   *
   * `?mine=true` returns the ones they belong to; the select then offers only
   * those they MANAGE, because publishing under an organization's name notifies
   * all of its members and only a manager may do that. The server re-checks with
   * the same `canManage` the organization routes use — this list exists so an
   * organizer is not offered a choice that will be refused.
   */
  const [manageableOrgs, setManageableOrgs] = useState([]);

  useEffect(() => {
    let cancelled = false;
    api.fetchOrganizations({ mine: true, limit: 50 })
      /**
       * FILTERED, which the comment above has always claimed and the code did
       * not do: `?mine=true` returns every organization the account belongs to,
       * so an organizer who had joined a club as an ordinary member was offered
       * it here and refused by the server on submit.
       *
       * `student_organizer` is included because that rank exists to put the
       * club's events up. `canHelpRun` on the server decides the same way, and
       * re-checks — this list only exists so nobody is offered a choice that
       * will be refused.
       */
      .then(res => {
        if (cancelled) return;
        const mine = res.organizations || [];
        setManageableOrgs(mine.filter((o) => {
          const rank = o.viewerRole ?? o.memberRole;
          return rank === 'manager' || rank === 'student_organizer';
        }));
      })
      /* A missing list is not an error worth showing: the field is optional, so
         it simply does not appear. */
      .catch(() => { if (!cancelled) setManageableOrgs([]); });
    return () => { cancelled = true; };
  }, []);

  const [form, setForm] = useState({
    title: '',
    category: 'School',
    description: '',
    instructions: '',
    location: { location: '', address: null, latitude: null, longitude: null },
    applicationDeadline: '',
    autoApprove: false,
    organizationId: '',
    /* `everyone` unless the organizer says otherwise, which is what every event
       on the platform was before there was a choice. */
    audience: 'everyone',
    creditsHours: true,
    attendeeVisibility: 'accepted',
    /* `{tag, label}` pairs, the same shape the API returns — so an edit loads its
       existing tags straight into this state with no conversion. */
    tags: []
  });
  const [errors, setErrors] = useState({});
  /**
   * Existing tags, offered as suggestions.
   *
   * A failure here is swallowed: suggestions are a shortcut, and an organizer who
   * cannot see them can still type any tag they like. Blocking the form — or
   * showing an error about a convenience — would be a worse outcome than a plain
   * text field.
   */
  const [tagSuggestions, setTagSuggestions] = useState([]);
  useEffect(() => {
    let cancelled = false;
    api.fetchEventTags()
      .then(res => { if (!cancelled) setTagSuggestions(res.tags || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const [submitting, setSubmitting] = useState(false);
  const slotCounter = useRef(0);
  const [dateInput, setDateInput] = useState('');
  const [dates, setDates] = useState([]);
  const [shift, setShift] = useState({
    name: '',
    description: '',
    startTime: '09:00',
    endTime: '11:00',
    maxSpots: '2',
    onDate: ''
  });
  const [slots, setSlots] = useState([]);
  const shiftHours = useMemo(() => {
    const [sh, sm] = shift.startTime.split(':').map(Number);
    const [eh, em] = shift.endTime.split(':').map(Number);
    const mins = eh * 60 + em - (sh * 60 + sm);
    return mins > 0 ? Number((mins / 60).toFixed(2)) : 0;
  }, [shift.startTime, shift.endTime]);
  useEffect(() => {
    if (dates.length && !dates.includes(shift.onDate)) setShift(s => ({
      ...s,
      onDate: dates[0]
    }));
  }, [dates, shift.onDate]);
  const set = (name, value) => {
    setForm(prev => ({
      ...prev,
      [name]: value
    }));
    if (errors[name]) setErrors(prev => ({
      ...prev,
      [name]: ''
    }));
  };
  const addDate = () => {
    if (!dateInput) return addToast('Pick a date first.', 'error');
    if (dates.includes(dateInput)) return addToast('That date is already on the list.', 'info');
    setDates(prev => [...prev, dateInput].sort());
    setDateInput('');
    setErrors(prev => ({
      ...prev,
      dates: ''
    }));
  };
  const removeDate = date => {
    setDates(prev => prev.filter(d => d !== date));
    setSlots(prev => prev.filter(s => s.date !== date));
  };
  const validShift = () => {
    if (!shift.name.trim()) {
      addToast('Name the shift, e.g. “Grill helper”.', 'error');
      return false;
    }
    if (shiftHours <= 0) {
      addToast('The end time must be after the start time.', 'error');
      return false;
    }
    if (Number(shift.maxSpots) < 1) {
      addToast('A shift needs at least one spot.', 'error');
      return false;
    }
    return true;
  };
  const buildSlot = date => {
    slotCounter.current += 1;
    return {
      id: `temp-${slotCounter.current}-${date}`,
      date,
      name: shift.name,
      description: shift.description,
      startDatetime: `${date}T${shift.startTime}:00`,
      endDatetime: `${date}T${shift.endTime}:00`,
      maxSpots: Number(shift.maxSpots) || 1,
      hours: shiftHours,
      startTime: shift.startTime,
      endTime: shift.endTime
    };
  };
  const addShift = scope => {
    if (dates.length === 0) return addToast('Add at least one date first.', 'error');
    if (!validShift()) return;
    const targets = scope === 'all' ? dates : [shift.onDate].filter(Boolean);
    if (targets.length === 0) return addToast('Choose which date this shift is on.', 'error');
    setSlots(prev => [...prev, ...targets.map(buildSlot)]);
    addToast(scope === 'all' ? `Added “${shift.name}” to all ${dates.length} dates.` : `Added “${shift.name}”.`, 'success');
    setShift(s => ({
      ...s,
      name: '',
      description: ''
    }));
    setErrors(prev => ({
      ...prev,
      slots: ''
    }));
  };
  const validate = () => {
    const next = {};
    if (!form.title.trim()) next.title = 'Give the event a name';
    if (!form.description.trim()) next.description = 'Tell volunteers what they\'ll be doing';
    const locText = typeof form.location === 'string' ? form.location : form.location?.location;
    if (!locText?.trim()) next.location = 'Add a location';
    if (!form.applicationDeadline) next.applicationDeadline = 'Set an application deadline';
    if (slots.length === 0) next.slots = 'Add at least one shift before publishing';
    if (orgRequired && !form.organizationId) {
      next.organizationId = 'Choose the organization this event is for';
    }
    if (form.applicationDeadline && slots.length > 0) {
      const first = new Date([...slots].sort((a, b) => a.startDatetime.localeCompare(b.startDatetime))[0].startDatetime);
      if (new Date(form.applicationDeadline) >= first) {
        next.applicationDeadline = 'The deadline has to be before the first shift starts';
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };
  const handleSubmit = async e => {
    e.preventDefault();
    if (!validate()) {
      addToast('Check the highlighted fields before publishing.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const loc = typeof form.location === 'string'
        ? { location: form.location, address: null, latitude: null, longitude: null }
        : form.location;
      await onSubmitEvent({
        title: form.title,
        description: form.description,
        instructions: form.instructions,
        category: form.category,
        location: loc.location,
        address: loc.address || null,
        latitude: loc.latitude != null ? loc.latitude : null,
        longitude: loc.longitude != null ? loc.longitude : null,
        applicationDeadline: new Date(form.applicationDeadline).toISOString(),
        autoApprove: form.autoApprove,
        attendeeVisibility: form.attendeeVisibility,
        /* Empty string means "no organization" — the server takes null or an
           absent field, and only a manager of the named organization may set
           one (it re-checks; this select only lists the ones they manage). */
        organizationId: form.organizationId || null,
        /* Forced back to open when no organization is chosen. "Members only" of
           nothing is a shift nobody can join, and the server refuses it — this
           keeps a stale radio from producing that request at all. */
        audience: form.organizationId ? form.audience : 'everyone',
        creditsHours: form.creditsHours,
        /* Sent as the raw labels. The server normalises and de-duplicates them —
           it is the authority on what a tag is, and sending the client's
           normalised keys would make the display casing the client's decision. */
        tags: form.tags.map(t => t.label),
        slots: slots.map(s => ({
          name: s.name,
          description: s.description,
          startDatetime: new Date(s.startDatetime).toISOString(),
          endDatetime: new Date(s.endDatetime).toISOString(),
          maxSpots: Number(s.maxSpots)
        }))
      });
      addToast(`“${form.title}” is live. Volunteers can apply now.`, 'success');
      setActiveTab('dashboard');
    } catch (err) {
      addToast(`Could not publish: ${err.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };
  const byDate = slots.reduce((acc, slot) => {
    (acc[slot.date] ||= []).push(slot);
    return acc;
  }, {});
  const totalSpots = slots.reduce((sum, s) => sum + s.maxSpots, 0);
  const totalHours = slots.reduce((sum, s) => sum + s.hours, 0);
  return <form onSubmit={handleSubmit} className="s-da7ecf">
      <div className="stack-lg">

        {/* ── 1. What and where ── */}
        <section className="card">
          <div className="card-head"><h2>About the event</h2></div>
          <div className="card-body">
            <div className="field s-535b39">
              <label htmlFor="ce-title">Event name</label>
              <input id="ce-title" className="input" value={form.title} placeholder="Softball tournament snack shack" aria-invalid={!!errors.title} onChange={e => set('title', e.target.value)} />
              {errors.title && <span className="field-error"><AlertCircle size={12} />{errors.title}</span>}
            </div>

            <div className="field-row">
              <div className="field s-535b39">
                <label htmlFor="ce-cat">Category</label>
                <select id="ce-cat" className="select" value={form.category} onChange={e => set('category', e.target.value)}>
                  {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
                {/* Category is the fixed five-value taxonomy the Impact Dashboard
                    aggregates on and the Auto Select draw reads; tags are the
                    open vocabulary beside it. Kept adjacent so the difference is
                    visible: one is a choice, the other is free text. */}
              </div>
              <div className="field s-535b39">
                <label>Location</label>
                <LocationPicker
                  value={form.location}
                  onChange={(loc) => set('location', loc)}
                  datetime={form.startDatetime}
                  error={errors.location}
                />
              </div>
            </div>

            <TagInput
              value={form.tags}
              onChange={(tags) => set('tags', tags)}
              suggestions={tagSuggestions}
            />

            {/**
              * Offered beside the input, never applied to it.
              *
              * `tagSuggestions` is the usage-ranked vocabulary already fetched
              * for the input's autocomplete, reused here so a proposal that
              * matches a tag other organizers already use adopts their
              * spelling instead of adding a synonym beside it.
              */}
            <TagSuggestions
              title={form.title}
              description={form.description}
              value={form.tags}
              vocabulary={tagSuggestions}
              onAdd={(label) => {
                const normalised = normaliseTag(label);
                if (!normalised) return;
                set('tags', form.tags.some(t => t.tag === normalised.tag)
                  ? form.tags
                  : [...form.tags, normalised]);
              }}
            />

            <div className="field">
              <label htmlFor="ce-desc">What volunteers need to know</label>
              <textarea id="ce-desc" className="textarea" value={form.description} placeholder="Every shift needs one adult because of the grill. Wear closed-toe shoes." aria-invalid={!!errors.description} onChange={e => set('description', e.target.value)} />
              {errors.description && <span className="field-error"><AlertCircle size={12} />{errors.description}</span>}
            </div>

            <div className="field">
              <label htmlFor="ce-deadline">Applications close</label>
              <input id="ce-deadline" type="datetime-local" className="input" value={form.applicationDeadline} aria-invalid={!!errors.applicationDeadline} onChange={e => set('applicationDeadline', e.target.value)} />
              {errors.applicationDeadline ? <span className="field-error"><AlertCircle size={12} />{errors.applicationDeadline}</span> : <span className="field-hint">Must be before your first shift starts.</span>}
            </div>

            <div className="field">
              <label htmlFor="ce-instr">
                Arrival instructions <span className="dim s-fe3f5c">(optional)</span>
              </label>
              <textarea id="ce-instr" className="textarea s-635b9f" value={form.instructions} placeholder="Park in the south lot and check in at the snack shack window." onChange={e => set('instructions', e.target.value)} />
              <span className="field-hint">
                Shown to volunteers once they're confirmed. You can post changes later as an update.
              </span>
            </div>

            {manageableOrgs.length > 0 && (
              <div className="field">
                <label htmlFor="ce-org">
                  Organization {!orgRequired && <span className="dim">(optional)</span>}
                </label>
                <select id="ce-org" className="select" value={form.organizationId}
                  aria-invalid={!!errors.organizationId}
                  onChange={e => set('organizationId', e.target.value)}>
                  {/* Offered only to somebody who could actually publish without
                      one. For a Student Organizer there is no such event, so the
                      option that leads to a 403 is not in the list. */}
                  {!orgRequired && <option value="">No organization</option>}
                  {orgRequired && <option value="">Choose an organization</option>}
                  {manageableOrgs.map(org => (
                    <option key={org.id} value={org.id}>{org.name}</option>
                  ))}
                </select>
                {errors.organizationId
                  ? <span className="field-error"><AlertCircle size={12} />{errors.organizationId}</span>
                  : (
                    <span className="field-hint">
                      The event appears on that organization&rsquo;s page, and its members are notified
                      that a new opportunity is open.
                    </span>
                  )}
              </div>
            )}

            {/**
              * Who may apply.
              *
              * Shown only once an organization is chosen, because that is the
              * only state in which the question has two answers — "members
              * only" of nothing is a shift nobody can join. Radios rather than
              * a checkbox: both options are named, so neither is the one you
              * get by not reading.
              *
              * A members-only event is still LISTED to everybody and still says
              * whose it is. Hiding it would mean somebody who would happily
              * join the club never learns the club exists; refusing the
              * application, with a reason, is the honest version.
              */}
            {form.organizationId && (
              <fieldset className="field">
                <legend className="label">Who can apply</legend>
                <div className="stack-sm">
                  <label className="check" data-checked={form.audience === 'everyone' ? 'true' : 'false'}>
                    <input
                      type="radio"
                      name="ce-audience"
                      checked={form.audience === 'everyone'}
                      onChange={() => set('audience', 'everyone')}
                    />
                    {/* `check-title` / `check-desc`, the idiom the Service hours
                        radios below already use. `field-hint` is inline, so the
                        description ran straight on from the title —
                        "EveryoneAnybody on WeVolunteer can apply." Measured at
                        320px. */}
                    <span>
                      <span className="check-title">Everyone</span>
                      <span className="check-desc">Anybody on WeVolunteer can apply.</span>
                    </span>
                  </label>
                  <label className="check" data-checked={form.audience === 'organization' ? 'true' : 'false'}>
                    <input
                      type="radio"
                      name="ce-audience"
                      checked={form.audience === 'organization'}
                      onChange={() => set('audience', 'organization')}
                    />
                    <span>
                      <span className="check-title">Members of this organization</span>
                      <span className="check-desc">
                        Everybody still sees the event and who it belongs to. Only members can take a place.
                      </span>
                    </span>
                  </label>
                </div>
              </fieldset>
            )}

            {/**
              * Hours are OPTIONAL, and the wording says what the alternative
              * means rather than naming a flag. Some real volunteering — a
              * donation drive, a one-off collection — is not measured in time,
              * and crediting "0 hours" for it would read as a failure rather
              * than as a category.
              */}
            <div className="field">
              <span className="label">Service hours</span>
              <div className="stack-sm">
                <label className="check" data-checked={form.creditsHours ? 'true' : 'false'}>
                  <input type="radio" name="creditsHours" checked={form.creditsHours}
                    onChange={() => set('creditsHours', true)} />
                  <span>
                    <span className="check-title">Award service hours</span>
                    <span className="check-desc">
                      Volunteers are credited for the time they work. You confirm the actual hours
                      on the attendance screen after each shift.
                    </span>
                  </span>
                </label>
                <label className="check" data-checked={!form.creditsHours ? 'true' : 'false'}>
                  <input type="radio" name="creditsHours" checked={!form.creditsHours}
                    onChange={() => set('creditsHours', false)} />
                  <span>
                    <span className="check-title">Participation only — no hours</span>
                    <span className="check-desc">
                      For activities time doesn&rsquo;t measure, like a donation drive. You still take
                      attendance, and it still counts toward a volunteer&rsquo;s events attended —
                      it just credits no hours.
                    </span>
                  </span>
                </label>
              </div>
            </div>

            <div className="field">
              <span className="label">Selection Method</span>
              <div className="stack-sm">
                <label className="check" data-checked={!form.autoApprove ? 'true' : 'false'}>
                  <input type="radio" name="approval" checked={!form.autoApprove} onChange={() => set('autoApprove', false)} />
                  <span>
                    <span className="check-title">Manual Review</span>
                    <span className="check-desc">
                      You review applicants after the deadline and choose who is accepted, waitlisted, or rejected.
                    </span>
                  </span>
                </label>
                <label className="check" data-checked={form.autoApprove ? 'true' : 'false'}>
                  <input type="radio" name="approval" checked={form.autoApprove} onChange={() => set('autoApprove', true)} />
                  <span>
                    <span className="check-title">Auto Select</span>
                    <span className="check-desc">
                      Students apply normally. After the deadline, the system automatically selects volunteers using weighted random selection based on hours.
                    </span>
                  </span>
                </label>
              </div>
            </div>

            <div className="field">
              <span className="label">Who can see the volunteer list</span>
              <div className="stack-sm">
                <label className="check" data-checked={form.attendeeVisibility === 'accepted' ? 'true' : 'false'}>
                  <input type="radio" name="visibility" checked={form.attendeeVisibility === 'accepted'} onChange={() => set('attendeeVisibility', 'accepted')} />
                  <span>
                    <span className="check-title">Confirmed volunteers</span>
                    <span className="check-desc">
                      People accepted for this event can see who else is coming. Helps students coordinate and makes events feel less intimidating to join.
                    </span>
                  </span>
                </label>
                <label className="check" data-checked={form.attendeeVisibility === 'private' ? 'true' : 'false'}>
                  <input type="radio" name="visibility" checked={form.attendeeVisibility === 'private'} onChange={() => set('attendeeVisibility', 'private')} />
                  <span>
                    <span className="check-title">Only me</span>
                    <span className="check-desc">Volunteers see how many spots are taken, but not who has them.</span>
                  </span>
                </label>
              </div>
            </div>
          </div>
        </section>

        {/* ── 2. Dates ── */}
        <section className="card">
          <div className="card-head">
            <h2>Dates</h2>
            <span className="small dim">{dates.length} added</span>
          </div>
          <div className="card-body">
            <p className="small muted s-22c500">
              Add every day this event runs. You'll attach shifts to them next.
            </p>

            <div className="row s-dffffd">
              <div className="field s-983db5">
                {/* `min` is today: a shift cannot be scheduled into the past,
                    and the picker refusing it is a clearer answer than the form
                    accepting it and the server rejecting the whole event.
                    Enter-to-add is handled by the picker's own typed input
                    committing on Enter, and `addDate` is still reachable by the
                    button beside it — so the keyboard shortcut this replaced is
                    not lost, it is just no longer the only way. */}
                <DatePicker
                  id="ce-date"
                  label="Date"
                  value={dateInput}
                  onChange={setDateInput}
                  min={new Date().toISOString().slice(0, 10)}
                />
              </div>
              <button type="button" className="btn btn-secondary" onClick={addDate}>
                <Plus size={14} /> Add date
              </button>
            </div>

            {dates.length > 0 && <div className="row row-wrap s-631d16">
                {dates.map(date => <span key={date} className="tag tag-brand s-b7cc9c">
                    {longDate(date)}
                    <button type="button" onClick={() => removeDate(date)} aria-label={`Remove ${longDate(date)}`} className="s-1daf8d">
                      <X size={12} />
                    </button>
                  </span>)}
              </div>}
          </div>
        </section>

        {/* ── 3. Shifts ── */}
        <section className="card">
          <div className="card-head">
            <h2>Shifts</h2>
            <span className="small dim">{slots.length} added</span>
          </div>
          <div className="card-body">
            {dates.length === 0 && <div className="alert alert-warn s-22c500">
                <Info size={15} className="s-d1467f" />
                <span>Add a date above before creating shifts.</span>
              </div>}

            <div className="field-row s-535b39">
              <div className="field s-535b39">
                <label htmlFor="ce-role">Role</label>
                <input id="ce-role" className="input" value={shift.name} placeholder="Grill helper" onChange={e => setShift(s => ({
                ...s,
                name: e.target.value
              }))} />
              </div>
              <div className="field s-535b39">
                <label htmlFor="ce-spots">Spots</label>
                <input id="ce-spots" type="number" min="1" className="input" value={shift.maxSpots} onChange={e => setShift(s => ({
                ...s,
                maxSpots: e.target.value
              }))} />
              </div>
            </div>

            <div className="field-row">
              <div className="field s-535b39">
                <label htmlFor="ce-start">Starts</label>
                <input id="ce-start" type="time" className="input" value={shift.startTime} onChange={e => setShift(s => ({
                ...s,
                startTime: e.target.value
              }))} />
              </div>
              <div className="field s-535b39">
                <label htmlFor="ce-end">Ends</label>
                <input id="ce-end" type="time" className="input" value={shift.endTime} onChange={e => setShift(s => ({
                ...s,
                endTime: e.target.value
              }))} />
              </div>
            </div>

            <div className="field">
              <label htmlFor="ce-sdesc">Details <span className="dim s-fe3f5c">(optional)</span></label>
              <input id="ce-sdesc" className="input" value={shift.description} placeholder="Walk the field and pick up litter" onChange={e => setShift(s => ({
              ...s,
              description: e.target.value
            }))} />
            </div>

            <div className="inset row-between row-wrap s-262f5d">
              <span className="small">
                Credits{' '}
                <span className={shiftHours > 0 ? 'strong' : ''} style={{
                color: shiftHours > 0 ? 'var(--accent)' : 'var(--danger)'
              }}>
                  {shiftHours > 0 ? formatHours(shiftHours) : 'invalid times'}
                </span>{' '}
                <span className="dim">per volunteer</span>
              </span>

              <div className="row row-wrap s-65ce96">
                {dates.length > 1 && <>
                    <select className="select s-684a19" value={shift.onDate} aria-label="Date for this shift" onChange={e => setShift(s => ({
                  ...s,
                  onDate: e.target.value
                }))}>
                      {dates.map(d => <option key={d} value={d}>{longDate(d)}</option>)}
                    </select>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => addShift('one')}>
                      Add to this date
                    </button>
                  </>}
                <button type="button" className="btn btn-primary btn-sm" onClick={() => addShift(dates.length > 1 ? 'all' : 'one')}>
                  <Plus size={13} /> {dates.length > 1 ? `Add to all ${dates.length} dates` : 'Add shift'}
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* ── 4. Preview: the sheet volunteers will see ── */}
        <section className="card">
          <div className="card-head">
            <h2>Preview</h2>
            {slots.length > 0 && <span className="small dim tnum">
                {slots.length} shift{slots.length !== 1 ? 's' : ''} · {totalSpots} spots · up to {formatHours(totalHours)}
              </span>}
          </div>

          {errors.slots && <div className="s-031457">
              <div className="alert alert-danger">
                <AlertCircle size={15} className="s-d1467f" />
                <span>{errors.slots}</span>
              </div>
            </div>}

          {slots.length === 0 ? <div className="empty">
              <span className="empty-icon"><Calendar size={18} /></span>
              <h3>Nothing to preview yet</h3>
              <p>Add dates and shifts above and your sign-up sheet builds itself here.</p>
            </div> : <div className="card-body">
              <div className="sheet">
                {Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, daySlots]) => <div key={date} className="sheet-daygroup">
                    <div className="sheet-dayhead">
                      <Calendar size={12} /> {longDate(date)}
                    </div>
                    {daySlots.map(slot => <div key={slot.id} className="sheet-row">
                        <div>
                          <div className="sheet-time">{time12(slot.startTime)}</div>
                          <div className="sheet-dur">to {time12(slot.endTime)} · {formatHours(slot.hours)}</div>
                        </div>
                        <div className="s-9e6bc3">
                          <div className="sheet-role">{slot.name}</div>
                          {slot.description && <div className="sheet-desc">{slot.description}</div>}
                        </div>
                        <div className="sheet-action">
                          <span className="seats-label">{slot.maxSpots} spot{slot.maxSpots !== 1 ? 's' : ''}</span>
                          <button type="button" className="btn btn-ghost btn-sm btn-icon s-973ad1" onClick={() => setSlots(prev => prev.filter(s => s.id !== slot.id))} aria-label={`Remove ${slot.name}`}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>)}
                  </div>)}
              </div>
            </div>}
        </section>

        <div className="row s-47d731">
          <button type="button" className="btn btn-ghost" onClick={() => setActiveTab('dashboard')}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-lg" disabled={submitting}>
            {submitting ? 'Publishing…' : 'Publish sign-up sheet'}
          </button>
        </div>
      </div>
    </form>;
}
function longDate(date) {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  });
}
function time12(time) {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
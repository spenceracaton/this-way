import { bindDialog } from './dialog.mjs';

const reasons = [
  ['incorrect-address', 'Incorrect address'],
  ['not-displayed', 'No longer on display'],
  ['inappropriate', 'Inappropriate display'],
  ['other', 'Something else']
];

function node(tag, attrs = {}, text = '') {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') element.className = value;
    else if (key === 'type' || key === 'name' || key === 'id' || key === 'maxlength' || key === 'required' || key === 'autocomplete' || key === 'inputmode' || key === 'rows' || key === 'for') element.setAttribute(key, value === true ? '' : value);
    else element.setAttribute(key, value);
  }
  if (text) element.textContent = text;
  return element;
}

function makeDialog(kind) {
  const report = kind === 'report';
  const dialog = node('dialog', { class: 'community-dialog', 'aria-labelledby': `${kind}-title` });
  const shell = node('section', { class: 'community-shell' });
  const heading = node('div', { class: 'community-heading' });
  const title = node('h2', { id: `${kind}-title`, tabindex: '-1' }, report ? 'Report this display' : 'Ideas or feedback?');
  const close = node('button', { type: 'button', class: 'community-close', 'aria-label': 'Close dialog' }, '×');
  heading.append(title, close);
  shell.append(heading);
  const form = node('form', { class: 'community-form', method: 'dialog', novalidate: '' });
  const address = report ? node('p', { class: 'community-address' }) : null;
  if (address) { address.setAttribute('aria-live', 'polite'); shell.append(address); }
  const fields = {};
  if (report) {
    const reasonLabel = node('label', { for: 'community-reason' }, 'Reason');
    reasonLabel.append(node('small', {}, ' (required)'));
    const select = node('select', { id: 'community-reason', name: 'reason', required: true, 'aria-describedby': 'community-reason-error' });
    select.append(node('option', { value: '' }, 'Choose a reason'));
    for (const [value, label] of reasons) select.append(node('option', { value }, label));
    const reasonError = node('p', { id: 'community-reason-error', class: 'community-error', role: 'status', 'aria-live': 'polite' });
    const detailLabel = node('label', { for: 'community-details' }, 'Additional details');
    detailLabel.append(node('small', {}, ' (optional)'));
    const details = node('textarea', { id: 'community-details', name: 'details', rows: '4', maxlength: '500', placeholder: 'Share anything that would help us review this report.' });
    form.append(reasonLabel, select, reasonError, detailLabel, details);
    fields.reason = select; fields.reasonError = reasonError; fields.details = details;
  } else {
    const messageLabel = node('label', { for: 'community-message' }, 'Your message');
    messageLabel.append(node('small', {}, ' (required)'));
    const message = node('textarea', { id: 'community-message', name: 'message', rows: '5', maxlength: '1000', required: true, placeholder: 'What would you like to share?' });
    const messageError = node('p', { class: 'community-error', role: 'status', 'aria-live': 'polite' });
    message.setAttribute('aria-describedby', 'community-message-error'); messageError.id = 'community-message-error';
    const emailLabel = node('label', { for: 'community-email' }, 'Contact email');
    emailLabel.append(node('small', {}, ' (optional)'));
    const email = node('input', { id: 'community-email', name: 'email', type: 'email', maxlength: '254', autocomplete: 'email', inputmode: 'email', placeholder: 'you@example.com', 'aria-describedby': 'community-email-error' });
    const emailError = node('p', { id: 'community-email-error', class: 'community-error', role: 'status', 'aria-live': 'polite' });
    form.append(messageLabel, message, messageError, emailLabel, email, emailError);
    fields.message = message; fields.messageError = messageError; fields.email = email; fields.emailError = emailError;
  }
  const actions = node('div', { class: 'community-actions' });
  const submit = node('button', { class: 'community-submit', type: 'submit' }, report ? 'Preview report' : 'Preview feedback');
  const cancel = node('button', { class: 'community-cancel', type: 'button' }, 'Cancel');
  actions.append(submit, cancel);
  const formNotice = node('p', { class: 'community-preview-notice community-form-notice' }, 'Preview only. Nothing will be sent.');
  form.append(formNotice, actions); shell.append(form);
  const preview = node('section', { class: 'community-preview', hidden: true, 'aria-labelledby': `${kind}-preview-title` });
  preview.append(node('h3', { id: `${kind}-preview-title` }, report ? 'Report preview' : 'Feedback preview'));
  const notice = node('p', { class: 'community-preview-notice' }, 'Preview only. Not sent.');
  const readback = node('div', { class: 'community-readback' });
  const edit = node('button', { class: 'community-submit', type: 'button' }, 'Edit');
  const done = node('button', { class: 'community-cancel', type: 'button' }, 'Done');
  const previewActions = node('div', { class: 'community-actions' });
  previewActions.append(edit, done); preview.append(notice, readback, previewActions); shell.append(preview);
  dialog.append(shell);
  return { dialog, title, close, form, fields, submit, cancel, address, preview, readback, edit, done };
}

function readbackLine(label, value) {
  const line = node('p');
  line.append(node('strong', {}, `${label}: `), document.createTextNode(value || '—'));
  return line;
}

export function initCommunityForms({ getSelected }) {
  const report = makeDialog('report');
  const feedback = makeDialog('feedback');
  document.body.append(report.dialog, feedback.dialog);
  const reportDialog = bindDialog(report.dialog, { initialFocus: () => report.title });
  const feedbackDialog = bindDialog(feedback.dialog, { initialFocus: () => feedback.title });
  let lastReportTarget = '';

  const open = (ui, controller, opener) => {
    ui.preview.hidden = true;
    ui.form.hidden = false;
    ui.title.textContent = ui === report ? 'Report this display' : 'Ideas or feedback?';
    if (ui === report) {
      const selected = getSelected?.();
      if (!selected) return;
      const address = selected.address || selected.name || selected.label || 'Selected display';
      const target = `${selected.id || ''}\u0000${address}`;
      if (target !== lastReportTarget) {
        ui.fields.reason.value = '';
        ui.fields.details.value = '';
        ui.fields.reasonError.textContent = '';
        ui.fields.reason.removeAttribute('aria-invalid');
        lastReportTarget = target;
      }
      ui.address.textContent = address;
    }
    controller.open(opener);
  };
  const closeReport = () => reportDialog.close();
  const closeFeedback = () => feedbackDialog.close();
  report.close.addEventListener('click', closeReport);
  report.cancel.addEventListener('click', closeReport);
  feedback.close.addEventListener('click', closeFeedback);
  feedback.cancel.addEventListener('click', closeFeedback);
  report.done.addEventListener('click', closeReport);
  feedback.done.addEventListener('click', closeFeedback);
  report.edit.addEventListener('click', () => { report.preview.hidden = true; report.form.hidden = false; report.fields.reason.focus(); });
  feedback.edit.addEventListener('click', () => { feedback.preview.hidden = true; feedback.form.hidden = false; feedback.fields.message.focus(); });

  report.form.addEventListener('submit', event => {
    event.preventDefault();
    if (!report.fields.reason.value) { report.fields.reasonError.textContent = 'Choose a reason for this report.'; report.fields.reason.setAttribute('aria-invalid', 'true'); report.fields.reason.focus(); return; }
    report.fields.reasonError.textContent = '';
    report.fields.reason.removeAttribute('aria-invalid');
    const reasonText = reasons.find(([value]) => value === report.fields.reason.value)?.[1] || '';
    report.readback.replaceChildren(readbackLine('Display', report.address.textContent), readbackLine('Reason', reasonText), readbackLine('Details', report.fields.details.value.trim()));
    report.form.hidden = true; report.preview.hidden = false; report.edit.focus();
  });
  feedback.form.addEventListener('submit', event => {
    event.preventDefault();
    const message = feedback.fields.message.value.trim();
    if (!message) { feedback.fields.messageError.textContent = 'Enter a message to preview.'; feedback.fields.message.setAttribute('aria-invalid', 'true'); feedback.fields.message.focus(); return; }
    feedback.fields.messageError.textContent = '';
    feedback.fields.message.removeAttribute('aria-invalid');
    if (!feedback.fields.email.checkValidity()) {
      feedback.fields.emailError.textContent = 'Enter a valid email address, or leave this field blank.';
      feedback.fields.email.setAttribute('aria-invalid', 'true'); feedback.fields.email.focus(); return;
    }
    feedback.fields.emailError.textContent = '';
    feedback.fields.email.removeAttribute('aria-invalid');
    feedback.readback.replaceChildren(readbackLine('Message', message), readbackLine('Contact email', feedback.fields.email.value.trim()));
    feedback.form.hidden = true; feedback.preview.hidden = false; feedback.edit.focus();
  });

  report.fields.reason.addEventListener('change', () => {
    report.fields.reasonError.textContent = '';
    report.fields.reason.removeAttribute('aria-invalid');
  });
  report.fields.details.addEventListener('input', () => {
    report.fields.reasonError.textContent = '';
    report.fields.reason.removeAttribute('aria-invalid');
  });
  feedback.fields.message.addEventListener('input', () => {
    feedback.fields.messageError.textContent = '';
    feedback.fields.message.removeAttribute('aria-invalid');
  });
  feedback.fields.email.addEventListener('input', () => {
    feedback.fields.emailError.textContent = '';
    feedback.fields.email.removeAttribute('aria-invalid');
  });

  document.getElementById('detail-report')?.addEventListener('click', event => open(report, reportDialog, event.currentTarget));
  document.querySelector('[data-open-feedback]')?.addEventListener('click', event => open(feedback, feedbackDialog, event.currentTarget));
  return { openReport: opener => open(report, reportDialog, opener), openFeedback: opener => open(feedback, feedbackDialog, opener) };
}

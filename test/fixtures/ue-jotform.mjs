// A cut-down copy of the live Jotform form 251396787451873 — same question
// titles and the shapes the Jotform API returns — used to test the importer
// and to build the schema the flow tests run against.
let order = 0;
const q = (qid, type, text, extra = {}) => ({ qid: String(qid), type, text, order: String(++order), name: extra.name || `q${qid}`, ...extra, required: extra.required ? 'Yes' : 'No' });

export const QUESTIONS = Object.fromEntries([
  q(60, 'control_text', '<h3><strong>Unearthed Education Application Form &amp; Program Deposit</strong></h3><p>payment is required at the end.</p>'),
  q(3, 'control_fullname', 'Name (**AS NOTED IN YOUR PASSPORT**)', { required: true, name: 'name' }),
  q(4, 'control_email', 'Student Email Address', { required: true, name: 'studentEmail' }),
  q(76, 'control_datetime', 'Date of Birth', { required: true, name: 'dateOf' }),
  q(5, 'control_pagebreak', 'Page Break'),
  q(6, 'control_head', 'Student Information'),
  q(13, 'control_textbox', 'What school do you attend?', { required: true, name: 'whatSchool' }),
  q(14, 'control_dropdown', 'What program are you attending', { options: 'Borneo 2027|Nepal 2028', name: 'whatProgram' }),
  q(11, 'control_radio', 'Choose your T-Shirt Size', { options: 'XS|S|M|L|XL', required: true, name: 'tshirt' }),
  q(12, 'control_fileupload', 'Upload a portrait photo of yourself', { name: 'portrait' }),
  q(15, 'control_head', 'Medical Details'),
  q(16, 'control_radio', 'Respiratory Problems or Asthma?', { options: 'Yes|No', required: true, name: 'asthma' }),
  q(26, 'control_textarea', 'If you answered YES to any of the above, please provide more information', { name: 'medicalMore' }),
  q(41, 'control_head', 'Travel Information'),
  q(42, 'control_radio', 'Do you hold a Passport?', { options: 'Yes|No', required: true, name: 'holdPassport' }),
  q(44, 'control_textbox', 'Passport Number', { name: 'passportNumber' }),
  q(89, 'control_fileupload', 'Passport Cover Page Photo', { hidden: 'Yes', name: 'passportCover' }),
  q(133, 'control_widget', 'Passport photo page', { name: 'passportPhoto', cfname: 'Passport bio page upload' }),
  q(48, 'control_head', 'Emergency contact information'),
  q(49, 'control_textbox', 'Primary Contact Name', { required: true, name: 'primaryContact' }),
  q(50, 'control_email', 'Primary Contact Email', { required: true, name: 'primaryContact50' }),
  q(64, 'control_phone', 'Primary Contact Phone Number', { required: true, name: 'primaryContact64' }),
  q(51, 'control_textbox', 'Relationship to student', { name: 'relationshipTo' }),
  q(54, 'control_radio', 'Would you like to enter a secondary emergency contact?', { options: 'Yes|No', name: 'secondary' }),
  q(55, 'control_textbox', 'Secondary emergency contact name', { name: 'secondaryEmergency' }),
  q(56, 'control_email', 'Secondary emergency contact email', { name: 'secondaryEmergency56' }),
  q(73, 'control_text', 'Please read and sign the permissions packet before moving onto the next step.'),
  q(75, 'control_checkbox', 'I have completely read and signed the permissions packet', { options: 'Yes', required: true, name: 'iHave' }),
  q(78, 'control_dropdown', 'Currency', { options: 'NZD|AUD|USD', name: 'currency' }),
  q(90, 'control_stripe', 'Program Deposit', { name: 'payment' }),
  q(2, 'control_button', 'Submit'),
].map((x) => [x.qid, x]));

export const PROPERTIES = {
  conditions: [
    { type: 'field', link: 'Any', terms: JSON.stringify([{ field: '16', operator: 'equals', value: 'Yes' }]), action: JSON.stringify([{ field: '26', visibility: 'Show' }]) },
    { type: 'field', link: 'Any', terms: JSON.stringify([{ field: '42', operator: 'equals', value: 'Yes' }]), action: JSON.stringify([{ field: '44', visibility: 'Show' }, { field: '133', visibility: 'Show' }]) },
    { type: 'field', link: 'Any', terms: JSON.stringify([{ field: '54', operator: 'equals', value: 'Yes' }]), action: JSON.stringify([{ fields: ['55', '56'], visibility: 'ShowMultiple' }]) },
  ],
};

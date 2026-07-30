import React from 'react';

const MicrosoftIcon = () => (
  <svg width="20" height="20" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg">
    <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
    <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
    <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
    <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
  </svg>
);

export default function MicrosoftButton({ onClick, text = "Continue with Microsoft", disabled = false, style = {} }) {
  return (
    <button
      type="button"
      className="btn btn-microsoft btn-block"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '12px',
        backgroundColor: '#ffffff',
        color: '#5e5e5e',
        border: '1px solid #8c8c8c',
        padding: '10px 16px',
        fontSize: '15px',
        fontWeight: '600',
        borderRadius: '6px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.7 : 1,
        transition: 'background-color 0.2s, box-shadow 0.2s',
        ...style
      }}
      onMouseOver={(e) => !disabled && (e.currentTarget.style.backgroundColor = '#f3f2f1')}
      onMouseOut={(e) => !disabled && (e.currentTarget.style.backgroundColor = '#ffffff')}
      onMouseDown={(e) => !disabled && (e.currentTarget.style.backgroundColor = '#edebe9')}
      onMouseUp={(e) => !disabled && (e.currentTarget.style.backgroundColor = '#f3f2f1')}
    >
      <MicrosoftIcon />
      <span>{text}</span>
    </button>
  );
}

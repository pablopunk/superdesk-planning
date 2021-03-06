import React from 'react';

const firstCharUpperCase = (string) => string && string.toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase());

const convertNewlineToBreak = (string) => !string ? '' :
    string.replace(/\r/g, '')
        .split('\n')
        .map((item, key) => <span key={key}>{item}<br /></span>);

// eslint-disable-next-line consistent-this
const self = {
    convertNewlineToBreak,
    firstCharUpperCase,
};

export default self;

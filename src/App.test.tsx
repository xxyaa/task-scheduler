import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

test('renders local scheduler title', () => {
  render(<App />);
  const titleElement = screen.getByText(/本地项目排程工具/i);
  expect(titleElement).toBeInTheDocument();
});

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** Invoked by the fallback's "Back to home" button — expected to leave the room, which
   * also clears the stored last-room id so the next load doesn't auto-rejoin the same
   * crashing room. */
  onLeave: () => void;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Last-ditch guard around the room views. Without it, a render crash inside Lobby/Game
 * unmounts the whole tree to a bare background — and because App auto-rejoins the stored
 * last room on every load, a room doc that reliably crashes the render locked that browser
 * out of the app entirely (the "screen just turns blue" bug). Show a way back to Home
 * instead, and clear the stored room id on the way out.
 */
export class RoomErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Room render crashed:', error, info.componentStack);
  }

  handleLeave = () => {
    this.props.onLeave();
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="app-loading">
        <p>Something went wrong loading this game.</p>
        <button type="button" className="app-crash__button" onClick={this.handleLeave}>
          Back to home
        </button>
      </div>
    );
  }
}

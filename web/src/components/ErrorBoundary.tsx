/*
 * ErrorBoundary.tsx — last-resort render error catcher.
 *
 * A render-time exception anywhere below this boundary shows a recovery UI rather
 * than a blank white screen. Class component because error boundaries require the
 * lifecycle methods React only exposes to classes.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Button, Card, CardBody } from './ui';
import { IconAlert } from './icons';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // No external telemetry in a local-only tool; log to the console for the
    // operator running it. (Never logs secrets — this is a render error.)
    console.error('UI render error:', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="state">
          <Card>
            <CardBody>
              <div className="stack stack-4">
                <div className="row row-3">
                  <span className="state__icon state__icon--danger">
                    <IconAlert size={20} />
                  </span>
                  <div className="stack stack-2">
                    <span className="state__title">The interface hit an error</span>
                    <span className="state__desc">
                      {this.state.error.message || 'An unexpected render error occurred.'}
                    </span>
                  </div>
                </div>
                <div className="row row-3">
                  <Button variant="primary" onClick={this.reset}>
                    Try again
                  </Button>
                  <Button variant="ghost" onClick={() => window.location.reload()}>
                    Reload
                  </Button>
                </div>
              </div>
            </CardBody>
          </Card>
        </div>
      );
    }
    return this.props.children;
  }
}

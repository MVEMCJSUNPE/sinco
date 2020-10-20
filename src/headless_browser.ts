// https://peter.sh/experiments/chromium-command-line-switches/

// Success response
// switch (result.result.type) {
//   case "object":
//     console.log('Result is an object')
//     break
//   case "string":
//     console.log("Result is a string")
//     break
//   case "undefined":
//     console.log('Command output returned undefined')
//     break
//   default:
//     throw new Error("Unhandled result type: " + result["result"]["type"])
// }

interface MessageResponse { // For when we send an event to get one back, eg running a JS expression
  id: number;
  result?: unknown; // Present on success
  error?: unknown; // Present on error
}

interface NotificationResponse { // Not entirely sure when, but when we send the `Network.enable` method
  method: string;
  params: unknown;
}

export function sleep(milliseconds: number): void {
  const start = new Date().getTime();
  for (let i = 0; i < 1e7; i++) {
    if ((new Date().getTime() - start) > milliseconds) {
      break;
    }
  }
}

const existsSync = (filename: string): boolean => {
  try {
    Deno.statSync(filename);
    // successful, file or directory must exist
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // file or directory does not exist
      return false;
    } else {
      // unexpected error, maybe permissions, pass it along
      throw error;
    }
  }
};

import {deferred, delay} from "../deps.ts";

export type ErrorResult = {
  className: string; // eg SyntaxError
  description: string; // eg SyntaxError: Unexpected Identifier
  objectId: {
    injectedScriptId: number;
    id: number;
  };
  subtype: string; // eg error
  type: string; // eg object
};

export type SuccessResult = {
  value?: string; // only present if type is a string or boolean
  type: string; // the type of result, eg object or string,
  className: string; // eg Location if command is `window.location`, only present when type is object
  description: string; // eg Location if command is `window.location`, only present when type is object
  objectId: string; // only present when type is object, eg '{"injectedScriptId":2,"id":2}'
};

export type UndefinedResult = { // not sure when this happens, but i believe it to be when the result of a command is undefined, for example if a command is `window.loction`
  type: string; // undefined
};

export type ExceptionDetails = { // exists when an error
  columnNumber: number;
  exception: {
    className: string; // eg SyntaxError
    description: string; // eg SyntaxError: Uncaught identifier
    objectId: string; // only present when type is object, eg '{"injectedScriptId":2,"id":2}'
    subtype: string; // eg error
    type: string; // eg object
  };
  exceptionId: number;
  lineNumber: number;
  scriptId: string; // eg "12"
  text: string; // eg Uncaught
};

export type DOMOutput = {
  result: SuccessResult | ErrorResult | UndefinedResult;
  exceptionDetails?: ExceptionDetails; // exists when an error, but an undefined response value wont trigger it, for example if the command is `window.loction`, there is no `exceptionnDetails` property, but if the command is `window.` (syntax error), this prop will exist
};

export class HeadlessBrowser {
  /**
   * The sub process that runs headless chrome
   */
  private readonly browser_process: Deno.Process;

  /**
   * Our web socket connection to the remote debugging port
   */
  private socket: WebSocket | null = null;

  /**
   * The endpoint our websocket connects to
   */
  private debug_url: string | null = null;

  /**
   * A counter that acts as the message id we use to send as part of the event data through the websocket
   */
  private next_message_id = 1;

  /**
   * Are we connected to the endpoint through the websocket
   */
  public connected = false;

  /**
   * Are we connectING to the endpoint
   */
  public connecting = false;

  /**
   * Tracks whether the user is done or not, to determine whether to reconnect to socket on disconnect
   */
  private is_done = false;

  // deno-lint-ignore allow-no-explicit-any Could MessageResponse.result or ".error
  private resolvables: { [key: number]: any } = {};

  /**
   * @param urlToVisit - The url to visit or open up
   */
  constructor(urlToVisit: string) {
    let chromePath = "";
    switch (Deno.build.os) {
      case "darwin":
        chromePath =
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        break;
      case "windows":
        const pathOne = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
        if (existsSync(pathOne)) {
          chromePath = pathOne
          break
        }
        const pathTwo = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        if (existsSync(pathTwo)) {
          chromePath = pathTwo
          break
        }
        throw new Error("Cannot find path for chrome in windows. Submit an issue if you encounter this error")
      case "linux":
        chromePath = "/usr/bin/google-chrome";
        break;
    }
    this.browser_process = Deno.run({
      cmd: [
        chromePath,
        "--headless",
        "--remote-debugging-port=9292",
        "--disable-gpu",
        urlToVisit,
      ],
      stderr: "piped", // so stuff isn't displayed in the terminal for the user
    });
  }

  /**
   * Creates the web socket connection to the headless chrome,
   * and initialises it so we can send events
   */
  public async start() {
    this.connecting = true;
    // Wait until the endpoint is actually ready eg the debugger is listening (it isn't ready instantly)
    while (true) {
      try {
        const res = await fetch("http://localhost:9292/json/list")
        const json = await res.json();
        const debugUrl = json[0]["webSocketDebuggerUrl"];
        this.debug_url = debugUrl
        break
      } catch (err) {
        // do nothing, loop again until it's ready
      }
    }

    console.log(`the debug url: ` + this.debug_url)
    this.socket = new WebSocket(this.debug_url || "");

    this.socket.onopen = () => {
      this.socket!.send(JSON.stringify({
        method: "Network.enable",
        id: this.next_message_id,
      }));
      this.next_message_id++;
    };

    // Listen for all events
    this.socket.onmessage = (event) => {
      const message: MessageResponse | NotificationResponse = JSON.parse(
        event.data,
      );
      if ((message as NotificationResponse).method) {
        if ((message as NotificationResponse).method === "Network.loadingFinished") {
          this.connected = true;
          this.connecting = false;
          return;
        }
      }
      if ("id" in message) { // message response
        const resolvable = this.resolvables[message.id];
        if (resolvable) {
          if ("result" in message) { // success response
            resolvable.resolve(message.result);
          }
          if ("error" in message) { // error response
            // todo throw error  using error message
            resolvable.reject(message.error);
          }
        }
      }
    };

    // general socket handlers
    this.socket.onclose = () => {
      this.connected = false;
      this.connecting = false;
      if (this.is_done === false) {
        // todo try reconnect
        throw new Error("Unhandled. todo");
      }
    };
    this.socket.onerror = (e) => {
      this.connected = false;
      this.connecting = false;
      if (this.is_done === false) {
        console.error(e);
        throw new Error("Unencountered error");
      }
    };
  }

  /**
   * Main method to handle sending messages/events to the websocket endpoint.
   *
   * @param method - Any DOMAIN, see sidebar at https://chromedevtools.github.io/devtools-protocol/tot/, eg Runtime.evaluate, or DOM.getDocument
   * @param params - Parameters required for the domain method
   *
   * @returns
   */
  protected async sendWebSocketMessage(
    method: string,
    params?: { [key: string]: unknown },
  ): Promise<unknown> {
    if (this.connected && this.socket) {
      const data: {
        id: number;
        method: string;
        params?: { [key: string]: unknown };
      } = {
        id: this.next_message_id++,
        method: method,
      };
      if (params) data.params = params;
      const pending = this.resolvables[data.id] = deferred();
      this.socket!.send(JSON.stringify(data));
      return await pending;
    } else if (this.connecting) {
      await delay(100);
      return await this.sendWebSocketMessage(method, params);
    }
  }

  /**
   * Clicks a button with the given selector
   *
   *     await this.click("#username");
   *     await this.click('button[type="submit"]')
   *
   * @param selector - The tag name, id or class
   */
  public async click(selector: string): Promise<void> {
    const command = `document.querySelector('${selector}').click()`;
    const result = await this.sendWebSocketMessage("Runtime.evaluate", {
      expression: command,
    });
    this.checkForErrorResult((result as DOMOutput), command);
    sleep(1000); // Need to wait, so click action has time to run before user sends next action
  }

  /**
   * Gets the text for the given selector
   * Must be an input element
   *
   * @param selector - eg input[type="submit"] or #submit
   *
   * @throws When:
   *     - Error with the element (using selector)
   *
   * @returns The text inside the selector, eg could be "" or "Edward"
   */
  public async getInputValue(selector: string): Promise<string> {
    const command = `document.querySelector('${selector}').value`;
    const res = await this.sendWebSocketMessage("Runtime.evaluate", {
      expression: command,
    });
    const type = (res as DOMOutput).result.type;
    if (type === "undefined") { // not an input elem
      return "undefined";
    }
    this.checkForErrorResult((res as DOMOutput), command);
    const value = ((res as DOMOutput).result as SuccessResult).value;
    return value || "";
  }

  /**
   * Wait for an AJAX request to finish, for example whe submitting a form,
   * wait for the request to complete before doing anything else
   */
  public async waitForAjax(): Promise<void> {
    const res = await this.sendWebSocketMessage("Runtime.evaluate", {
      expression: "!$.active",
    });
    this.checkForErrorResult((res as DOMOutput), "!$.active");
  }

  /**
   * Close/stop the sub process. Must be called when finished with all your testing
   */
  public async done(): Promise<void> {
    sleep(1000); // If we try close before the ws endpoint has not finished sending all messages from the Network.enable method, async ops are leaked
    const promise = deferred();
    this.is_done = true;
    this.browser_process.stderr!.close();
    this.browser_process.close();
    this.socket!.addEventListener("close", function () {
      promise.resolve();
    });
    this.socket!.close();
    await promise;
  }

  /**
   * Type into an input element, by the given selector
   *
   *     <input name="city"/>
   *
   *     await this.type('input[name="city"]', "Stockholm")
   *
   * @param selector - The value for the name attribute of the input to type into
   * @param value - The value to set the input to
   */
  public async type(selector: string, value: string): Promise<void> {
    const command = `document.querySelector('${selector}').value = "${value}"`;
    const res = await this.sendWebSocketMessage("Runtime.evaluate", {
      expression: command,
    });
    this.checkForErrorResult((res as DOMOutput), command);
    sleep(500);
  }

  /**
   * Checks if the result is an error
   *
   * @param result - The DOM result response, after writing to stdin and getting by stdout of the process
   * @param commandSent - The command sent to trigger the result
   */
  protected checkForErrorResult(result: DOMOutput, commandSent: string): void {
    // Is an error
    if (result.exceptionDetails) { // Error with the sent command, maybe there is a syntax error
      const exceptionDetail = (result.exceptionDetails as ExceptionDetails);
      const errorMessage = exceptionDetail.exception.description;
      if (exceptionDetail.exception.description.indexOf("SyntaxError") > -1) { // a syntax error
        const message = errorMessage.replace("SyntaxError: ", "");
        throw new SyntaxError(message + ": `" + commandSent + "`");
      } else { // any others, unsure what they'd be
        throw new Error(`${errorMessage}: "${commandSent}"`);
      }
    }
  }
}

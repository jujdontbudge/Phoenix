# Phoenix ships no improver agent

Phoenix does not build its own improver. Any outside agent a person already uses connects to the sandbox and acts as the Improver, so phoenix exposes the sandbox as an interface any agent can drive, and the agent, its LLM and its provider are the person's choice. Building an in-house improver was rejected because it would tie phoenix to one LLM and duplicate what people's own coding agents already do well.

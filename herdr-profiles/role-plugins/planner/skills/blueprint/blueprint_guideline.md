# Blueprint Guideline

The purpose of this guideline is to assist developers in creating effective blueprints. The Blueprint Template outlines sections that require detailed information, along with a brief description of each section's intent. This guide provides specifics to ensure a comprehensive and practical blueprint.

### Blueprint Principles

Blueprints are high-level technical documents that focus on system design and key architectural decisions. They differ from design documents, which delve into details such as database table design, implementation specifics, and API design. Teams are encouraged to create separate, detailed design documents for these aspects to allow for focused iteration and discussion.

### Relevance Over Time

A blueprint should remain relevant for an extended period. Overly detailed implementation information can quickly become obsolete. Focus on high-level design and strategic decisions instead.

### Technology Decision Rationale

Clearly document the reasons behind specific technology choices, such as opting for a relational database over a non-relational one. These decisions are often costly to reverse and should be well-documented.

### Clarity, Conciseness, and Efficiency

The blueprint should be clear, direct, and efficient. Favor bullet points, tables, and clear headings over lengthy text. Avoid verbose expressions like “It is worth noting that,” “In order to,” or “However, it is important to consider that.” Strive for a style that conveys necessary information succinctly and directly.

By adhering to these principles, blueprints can effectively guide development processes, ensure alignment with organizational standards, and facilitate clear communication among team members.

### Handling API Design

Since many services expose APIs (REST, GraphQL, etc.), their specifications should be documented separately to avoid diverting focus from core architectural decisions. While acknowledging the presence of an API is important, detailing its design within the blueprint may sidetrack discussions from crucial architectural decisions. To maintain focus, document API specifics separately.
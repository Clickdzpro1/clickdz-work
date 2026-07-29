#!/bin/sh
# Patch graphql-upload for Node 22: add named export + barrel "." export
node -e '
var f=require("fs");
var m="/app/node_modules/graphql-upload/graphqlUploadExpress.mjs";
var s=f.readFileSync(m,"utf8");
s=s.replace("export default","const _g=")+"\nexport const graphqlUploadExpress=_g;\nexport default _g;\n";
f.writeFileSync(m,s);
var p=JSON.parse(f.readFileSync("/app/node_modules/graphql-upload/package.json","utf8"));
p.exports["."]={import:"./graphqlUploadExpress.mjs",default:"./graphqlUploadExpress.mjs"};
f.writeFileSync("/app/node_modules/graphql-upload/package.json",JSON.stringify(p));
console.log("[fix-gql] patched graphql-upload");
'

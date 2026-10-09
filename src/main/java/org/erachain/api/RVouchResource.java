package org.erachain.api;

import org.erachain.controller.Controller;
import org.erachain.core.account.PrivateKeyAccount;
import org.erachain.core.transaction.Transaction;
import org.erachain.datachain.DCSet;
import org.erachain.utils.APIUtils;
import org.erachain.utils.StrJSonFine;
import org.json.simple.JSONObject;

import javax.servlet.http.HttpServletRequest;
import javax.ws.rs.*;
import javax.ws.rs.core.Context;
import javax.ws.rs.core.MediaType;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Заверение (подпись второй стороной) существующей транзакции: договора, документа, перевода.
 */
@Path("r_vouch")
@Produces(MediaType.APPLICATION_JSON)
public class RVouchResource {

    @Context
    HttpServletRequest request;

    @GET
    public String help() {
        Map<String, String> help = new LinkedHashMap<>();
        help.put("GET r_vouch/{creator}/{seqNo}?feePow=0&password={password}",
                "Vouch (sign by creator) the transaction with given SeqNo, for example 12345-1");
        return StrJSonFine.convert(help);
    }

    @GET
    @Path("{creator}/{seqNo}")
    public String vouch(@PathParam("creator") String creatorStr, @PathParam("seqNo") String seqNoStr,
                        @DefaultValue("0") @QueryParam("feePow") int feePow,
                        @QueryParam("password") String password) {

        APIUtils.askAPICallAllowed(password, "GET r_vouch " + seqNoStr, request, true);

        Long dbRef = Transaction.parseDBRefSeqNo(seqNoStr);
        if (dbRef == null)
            throw ApiErrorFactory.getInstance().createError(Transaction.INVALID_BLOCK_TRANS_SEQ_ERROR);

        Transaction record = DCSet.getInstance().getTransactionFinalMap().get(dbRef);
        if (record == null)
            throw ApiErrorFactory.getInstance().createError(Transaction.TRANSACTION_DOES_NOT_EXIST);

        Controller cntr = Controller.getInstance();
        PrivateKeyAccount creator = cntr.getWalletPrivateKeyAccountByAddress(creatorStr);
        if (creator == null)
            throw ApiErrorFactory.getInstance().createError(Transaction.INVALID_WALLET_ADDRESS);

        Transaction transaction = cntr.r_Vouch(0, Transaction.FOR_NETWORK, creator, feePow,
                record.getBlockHeight(), record.getSeqNo());

        int validate = cntr.getTransactionCreator().afterCreate(transaction, Transaction.FOR_NETWORK, false, false);
        if (validate == Transaction.VALIDATE_OK)
            return transaction.toJson().toJSONString();

        JSONObject out = new JSONObject();
        transaction.updateMapByError(validate, out);
        return out.toJSONString();
    }

}

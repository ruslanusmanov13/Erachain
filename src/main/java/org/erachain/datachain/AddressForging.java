package org.erachain.datachain;

import org.mapdb.BTreeMap;
import org.mapdb.DB;
import org.mapdb.Fun;
import org.mapdb.Fun.Tuple2;

import java.util.Collection;
import java.util.HashMap;
import java.util.Map;

//import java.util.List;
//import java.util.TreeMap;
//import java.util.TreeSet;
//import org.mapdb.Fun.Tuple3;

/*
 */

//
// last forged block for ADDRESS -> by height = 0
/**
 * Хранит данные о сборке блока для данного счета - по номеру блока
 * если номер блока не задан - то это последнее значение.
 * При этом если номер блока не задана то хранится поледнее значение
 *  account.address + current block.Height ->
 *     previous making blockHeight + this ForgingH balance
<hr>
 - not SAME with BLOCK HEADS - use point for not only forged blocks - with incoming ERA Volumes
 <br>
 Так же тут можно искать блоки собранны с данного счета - а вторичный индекс у блоков не нужен

 * @return
 */

// TODO укротить до 20 байт адрес
public class AddressForging extends DCMap<Tuple2<String, Integer>, Tuple2<Integer, Integer>> {
    private Map<Integer, Integer> observableData = new HashMap<Integer, Integer>();


    public AddressForging(DCSet databaseSet, DB database) {
        super(databaseSet, database);
    }

    public AddressForging(AddressForging parent) {
        super(parent, null);
    }

    @Override
    protected void createIndexes(DB database) {
    }

    @Override

    protected Map<Tuple2<String, Integer>, Tuple2<Integer, Integer>> getMap(DB database) {
        //OPEN MAP
        return database.getTreeMap("address_forging");
    }

    @Override
    protected Map<Tuple2<String, Integer>, Tuple2<Integer, Integer>> getMemoryMap() {
        return new HashMap<Tuple2<String, Integer>, Tuple2<Integer, Integer>>();
    }

    @Override
    protected Tuple2<Integer, Integer> getDefaultValue() {
        return null; //new Tuple2<Integer, Integer>(-1, 0);
    }

    @Override
    protected Map<Integer, Integer> getObservableData() {
        return this.observableData;
    }

    public Tuple2<Integer, Integer> get(String address, int height) {
        Tuple2<Integer, Integer> point = this.get(new Tuple2<String, Integer>(address, height));
        if (point == null)
            return this.get(new Tuple2<String, Integer>(address, 0));

        return point;

    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    public Collection<Tuple2<Integer, Integer>> getGeneratorBlocks(String address) {
        Collection<Tuple2<Integer, Integer>> headers = ((BTreeMap) (this.map))
                .subMap(Fun.t2(address, null), Fun.t2(address, Fun.HI())).values();

        return headers;
    }

    // height
    public void set(String address, Integer currentHeight, Integer currentForgingVolume) {

        Tuple2<Integer, Integer> previousPoint = this.getLast(address);
        if (previousPoint != null && currentHeight > previousPoint.a) {
            this.set(new Tuple2<String, Integer>(address, currentHeight), previousPoint);
        }

        this.setLast(address, new Tuple2<Integer, Integer>(currentHeight, currentForgingVolume));

    }

    public void delete(String address, int height) {

        if (height < 3) {
            // not delete GENESIS forging data for all accounts
            return;
        }

        //Tuple2<String, Integer> keyLast = new Tuple2<String, Integer>(address, 0);
        //Tuple2<Integer, Integer> last = this.get(keyLast);
        Tuple2<String, Integer> key = new Tuple2<String, Integer>(address, height);
        Tuple2<Integer, Integer> previous = this.get(key);

        this.delete(key);
        this.setLast(address, previous);

    }

    public Tuple2<Integer, Integer> getLast(String address) {
        return this.get(new Tuple2<String, Integer>(address, 0));
    }

    private void setLast(String address, Tuple2<Integer, Integer> point) {
        if (point == null) {
            this.delete(new Tuple2<String, Integer>(address, 0));
        } else {
            this.set(new Tuple2<String, Integer>(address, 0), point);
        }
    }
}